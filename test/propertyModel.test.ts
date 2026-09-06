/**
 * The property inspector's model — the four states, and the editing rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCall, bySection, commitValue, editorFor, propertyRows, readPath,
} from '../src/core/propertyModel';
import type { StructureNode } from '../src/core/structure';

const node = (over: Partial<StructureNode>): StructureNode => ({
  nodeId: 'n1', name: 'IntakePrepare', named: true, type: 'ActionButton',
  props: [], stylable: true, children: [], ...over,
});

const CONTEXT = {
  components: {
    IntakePrepare: { disabled: true, label: 'Prepare' },
    AssetIntakeForm: { data: { title: 'Screen Runner capture', count: 3, note: null } },
  },
};

/* ── The four states ─────────────────────────────────────────────────────── */

test('a prop with a transform is dynamic and carries its live value', () => {
  const rows = propertyRows(node({ props: ['disabled'] }), CONTEXT);
  const disabled = rows.find((r) => r.name === 'disabled');
  assert.equal(disabled?.state, 'dynamic');
  assert.equal(disabled?.value, true);
  assert.equal(disabled?.hasValue, true);
});

test('a transformable prop set to a literal is static, not fixed', () => {
  const rows = propertyRows(node({ props: [] }), CONTEXT);
  assert.equal(rows.find((r) => r.name === 'disabled')?.state, 'static');
});

test('a prop that never accepts a transform is fixed', () => {
  const rows = propertyRows(node({}), CONTEXT);
  assert.equal(rows.find((r) => r.name === 'label')?.state, 'fixed');
});

// The distinction this whole module exists to protect. Note the two axes are
// independent: a transform we can see makes the *state* dynamic even when the
// element type is undocumented, which leaves the *type* unknown.
test('an undocumented element type leaves the field type unknown', () => {
  const rows = propertyRows(node({ type: 'NeverSeenElement', props: ['mystery'] }), CONTEXT);
  assert.equal(rows.length, 1, 'only the props the design actually uses');
  assert.equal(rows[0].type, 'unknown');
  assert.equal(rows[0].state, 'dynamic', 'the transform is observed, so this much is known');
});

test('an undocumented type claims no props it has not seen', () => {
  const rows = propertyRows(node({ type: 'NeverSeenElement', props: [] }), CONTEXT);
  assert.deepEqual(rows, [], 'inventing props for an unknown type would be a fabrication');
});

test('a prop the design uses but the skill omits still appears', () => {
  const rows = propertyRows(node({ props: ['undocumentedThing'] }), CONTEXT);
  const extra = rows.find((r) => r.name === 'undocumentedThing');
  assert.ok(extra, 'a prop in use must never be hidden');
  assert.equal(extra?.type, 'unknown');
});

test('rows carry the skill description and section', () => {
  const rows = propertyRows(node({}), CONTEXT);
  const label = rows.find((r) => r.name === 'label');
  assert.equal(label?.description, 'Button label');
  assert.equal(label?.section, 'Basic');
});

test('a missing value is distinguishable from a null one', () => {
  const rows = propertyRows(node({ name: 'Nowhere' }), CONTEXT);
  assert.equal(rows.every((r) => r.hasValue === false), true);
});

test('rows group by the designer panel section', () => {
  const groups = bySection(propertyRows(node({}), CONTEXT));
  assert.ok(groups.some((g) => g.section === 'Basic'));
});

/* ── Path reading ────────────────────────────────────────────────────────── */

test('readPath separates a missing key from a null value', () => {
  assert.deepEqual(readPath(CONTEXT, 'components.AssetIntakeForm.data.note'), { found: true, value: null });
  assert.deepEqual(readPath(CONTEXT, 'components.AssetIntakeForm.data.nope'), { found: false });
  assert.deepEqual(readPath(CONTEXT, 'components.Nope.data'), { found: false });
});

/* ── Editing ─────────────────────────────────────────────────────────────── */

// "edit the value, never its punctuation"
test('a string edits without its surrounding quotes', () => {
  const e = editorFor('Screen Runner capture', true);
  assert.equal(e.kind, 'string');
  assert.equal(e.text, 'Screen Runner capture');
  assert.doesNotMatch(e.text, /^"/);
});

test('objects open as real JSON, never as a summary', () => {
  const e = editorFor({ a: 1, b: [1, 2] }, true);
  assert.equal(e.kind, 'json');
  assert.equal(e.multiline, true);
  assert.deepEqual(JSON.parse(e.text), { a: 1, b: [1, 2] });
});

test('a multi-line string opens in a multi-line editor', () => {
  assert.equal(editorFor('a\nb', true).multiline, true);
});

// Guessing the type from the input is how `false` becomes truthy `"false"`.
test('type is preserved from the original, not inferred from the text', () => {
  assert.deepEqual(commitValue('boolean', 'false'), { ok: true, value: false });
  assert.deepEqual(commitValue('number', '640'), { ok: true, value: 640 });
  assert.deepEqual(commitValue('string', 'false'), { ok: true, value: 'false' });
});

test('invalid input is rejected with a reason, leaving the value untouched', () => {
  assert.equal(commitValue('boolean', 'yes').ok, false);
  assert.equal(commitValue('number', 'abc').ok, false);
  assert.equal(commitValue('json', '{nope}').ok, false);
  assert.equal(commitValue('expression', '   ').ok, false);
  assert.match(commitValue('number', 'abc').error ?? '', /not a number/);
});

test('null round-trips, but can be replaced', () => {
  assert.deepEqual(commitValue('null', 'null'), { ok: true, value: null });
  assert.deepEqual(commitValue('null', 'hello'), { ok: true, value: 'hello' });
});

/* ── Applying ────────────────────────────────────────────────────────────── */

const formNode = node({ name: 'AssetIntakeForm', type: 'Form' });

test('a form field applies through the runtime setValue', () => {
  const rows = propertyRows(formNode, CONTEXT);
  const row = { ...rows[0], name: 'data.title', edit: { tier: 'runtime' as const, reason: '' } };
  assert.deepEqual(applyCall(row, formNode, 'new title', ['setValue', 'setData']),
    { fn: 'setValue', args: ['title', 'new title'] });
});

test('visibility maps to show or hide by the value', () => {
  const row = { name: 'visible', edit: { tier: 'runtime' as const, reason: '' } } as never;
  assert.deepEqual(applyCall(row, formNode, true, ['show', 'hide']), { fn: 'show', args: [] });
  assert.deepEqual(applyCall(row, formNode, false, ['show', 'hide']), { fn: 'hide', args: [] });
});

// A control that appears to work but does nothing is the worst outcome.
test('nothing is applied when the component does not expose the function', () => {
  const row = { name: 'data.title', edit: { tier: 'runtime' as const, reason: '' } } as never;
  assert.equal(applyCall(row, formNode, 'x', []), undefined);
});

test('a preview-tier property never produces an apply call', () => {
  const row = { name: 'disabled', edit: { tier: 'preview' as const, reason: '' } } as never;
  assert.equal(applyCall(row, formNode, true, ['setValue', 'disableField']), undefined);
});
