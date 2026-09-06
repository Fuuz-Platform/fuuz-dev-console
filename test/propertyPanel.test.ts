/**
 * Organising one element's properties.
 *
 * The platform's own panel for a single SelectInput runs to ~7,600px with every property
 * present whether set or not. This one answers "what is true about this element", so the
 * decisions under test are all about what gets shown first and what gets hidden — and about
 * never hiding something a search should have found.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanel, isSet, problemsFor, provenanceOf, summarise } from '../src/core/propertyPanel';
import type { PropertyRow } from '../src/core/propertyModel';

const row = (over: Partial<PropertyRow> = {}): PropertyRow => ({
  name: 'p', state: 'static', type: 'text', description: '', hasValue: false,
  edit: { tier: 'none', reason: 'test fixture' }, ...over,
});

/* ── Provenance: the column the authoring panel cannot show ───────────────── */

test('a transform-computed property says so', () => {
  assert.equal(provenanceOf(row({ state: 'dynamic', hasValue: true, value: false })), 'transform');
});

test('a literal that differs from the default is authored', () => {
  assert.equal(provenanceOf(row({ hasValue: true, value: '420px', defaultValue: 'auto' })), 'authored');
});

// Fifty untouched properties shown as "set" makes them all look deliberate.
test('a value equal to its default is a default, not a setting', () => {
  assert.equal(provenanceOf(row({ hasValue: true, value: 'auto', defaultValue: 'auto' })), 'default');
  assert.equal(provenanceOf(row({ hasValue: true, value: 8, defaultValue: '8' })), 'default');
});

test('nothing set and no documented default is unset', () => {
  assert.equal(provenanceOf(row()), 'unset');
  assert.equal(provenanceOf(row({ defaultValue: 'auto' })), 'default');
});

// Undocumented and empty is "we do not know", which is not the same as "none".
test('an undocumented property is unknown until it holds something', () => {
  assert.equal(provenanceOf(row({ state: 'unknown' })), 'unknown');
  assert.equal(provenanceOf(row({ state: 'unknown', hasValue: true, value: 1 })), 'runtime');
});

test('only transforms, authored values and runtime values count as set', () => {
  assert.equal(isSet(row({ state: 'dynamic' })), true);
  assert.equal(isSet(row({ hasValue: true, value: 'x' })), true);
  assert.equal(isSet(row({ defaultValue: 'auto' })), false);
});

/* ── Scope: the dozen that matter, not the sixty that exist ───────────────── */

const ROWS = [
  row({ name: 'dataPath', section: 'Data', hasValue: true, value: 'assetCollection' }),
  row({ name: 'disabled', section: 'Advanced', state: 'dynamic', hasValue: true, value: false, expression: '$state.locked' }),
  row({ name: 'height', section: 'Display', hasValue: true, value: 'auto', defaultValue: 'auto' }),
  row({ name: 'padding', section: 'Display', defaultValue: '8' }),
  row({ name: 'unique', section: 'Validation' }),
];

test('the default scope shows only what is set, and says how many it hides', () => {
  const panel = buildPanel(ROWS, [], { scope: 'set' });
  const names = panel.groups.flatMap((g) => g.rows.map((r) => r.name));
  assert.deepEqual(names.sort(), ['dataPath', 'disabled']);
  assert.equal(panel.counts.hidden, 3);
  assert.equal(panel.counts.total, 5);
});

test('the all scope hides nothing', () => {
  assert.equal(buildPanel(ROWS, [], { scope: 'all' }).groups.flatMap((g) => g.rows).length, 5);
});

// Someone cross-referencing the two panels must find the same properties in the same places.
test('sections keep the platform’s own names and order, with Data first', () => {
  const titles = buildPanel(ROWS, [], { scope: 'all' }).groups.map((g) => g.title);
  // The platform's own order: Basic, Display, Behavior, Validation, Advanced — with Data
  // lifted to the front, because a binding is where a diagnostic session starts.
  assert.deepEqual(titles, ['Data', 'Display', 'Validation', 'Advanced']);
});

// Behaviour outranks configuration.
test('a transform sorts to the top of its section', () => {
  const mixed = [
    row({ name: 'zzz', section: 'Basic', hasValue: true, value: 1 }),
    row({ name: 'aaa', section: 'Basic', state: 'dynamic', hasValue: true, value: 2 }),
  ];
  const group = buildPanel(mixed, [], { scope: 'all' }).groups[0];
  assert.deepEqual(group.rows.map((r) => r.name), ['aaa', 'zzz']);
});

test('a section holding a transform arrives open', () => {
  const panel = buildPanel(ROWS, [], { scope: 'all' });
  assert.equal(panel.groups.find((g) => g.title === 'Advanced')?.open, true);
  assert.equal(panel.groups.find((g) => g.title === 'Validation')?.open, false);
});

/* ── Search ───────────────────────────────────────────────────────────────── */

// The one outcome a search must never produce is a match behind a collapsed heading.
test('a search opens every group', () => {
  const panel = buildPanel(ROWS, [], { scope: 'all', query: 'unique' });
  assert.ok(panel.groups.every((g) => g.open));
});

// "Which transform reads $state.locked" cannot be answered from property names.
test('expressions are searchable', () => {
  const panel = buildPanel(ROWS, [], { scope: 'all', query: '$state.locked' });
  assert.deepEqual(panel.groups.flatMap((g) => g.rows.map((r) => r.name)), ['disabled']);
});

test('values and sections are searchable too', () => {
  assert.equal(buildPanel(ROWS, [], { scope: 'all', query: 'assetcollection' }).groups.length, 1);
  assert.equal(buildPanel(ROWS, [], { scope: 'all', query: 'validation' }).groups.length, 1);
});

// A group labelled "8" that shows two rows is worse than no count.
test('group counts reflect what is shown, not what exists', () => {
  const panel = buildPanel(ROWS, [], { scope: 'set' });
  for (const g of panel.groups) assert.equal(g.set, g.rows.filter(isSet).length);
});

/* ── Problems, which are why you opened the panel ─────────────────────────── */

// The symptom of an unresolved read is a null, which points nowhere near the cause.
test('an unresolved read is a high-severity problem naming the path', () => {
  const problems = problemsFor([], [
    { writes: 'components.X.url', inputs: [{ path: '$state.libraryId', resolved: false }] },
  ]);
  assert.equal(problems[0].severity, 'high');
  assert.equal(problems[0].property, 'url');
  assert.match(problems[0].summary, /\$state\.libraryId/);
});

test('a transform that produced nothing is flagged', () => {
  const problems = problemsFor([row({ name: 'visible', state: 'dynamic' })], []);
  assert.equal(problems[0].property, 'visible');
  assert.match(problems[0].summary, /never ran, or returned nothing/);
});

test('a healthy element has no problems, so nothing is shown', () => {
  const panel = buildPanel([row({ name: 'x', state: 'dynamic', hasValue: true, value: 1 })], [
    { writes: 'components.X.x', inputs: [{ path: '$state.a', resolved: true }] },
  ]);
  assert.deepEqual(panel.problems, []);
  assert.equal(panel.counts.problems, 0);
});

test('the problems scope shows only the properties implicated', () => {
  const rows = [row({ name: 'visible', state: 'dynamic' }), row({ name: 'other', hasValue: true, value: 1 })];
  const panel = buildPanel(rows, [], { scope: 'problems' });
  assert.deepEqual(panel.groups.flatMap((g) => g.rows.map((r) => r.name)), ['visible']);
});

/* ── Summaries, instead of 800px of inline checkboxes ─────────────────────── */

test('a large value collapses to a count', () => {
  assert.equal(summarise([1, 2, 3]), '[ 3 items ]');
  assert.equal(summarise({ a: 1, b: 2, c: 3, d: 4, e: 5 }), '{ a, b, c, +2 }');
});

test('scalars and null keep their meaning', () => {
  assert.equal(summarise(null), 'null');
  assert.equal(summarise(false), 'false');
  assert.equal(summarise(undefined), '');
});

test('a long string is truncated rather than wrapping the panel', () => {
  assert.equal(summarise('x'.repeat(100)).length, 61);
});
