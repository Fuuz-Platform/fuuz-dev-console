/**
 * Path completion — and the thing it exists for: showing what is *in* a path,
 * not merely that the path could be typed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCompletion, completionsAt } from '../src/core/completions';

const CONTEXT = {
  components: {
    AssetIntakeForm: { data: { title: 'Screen Runner capture', count: 3, note: null } },
    TicketTable: { data: [] },
  },
  metadata: { user: { id: 'clbl0001' } },
};

const at = (text: string, caret = text.length, elements?: { name: string; type: string }[]) =>
  completionsAt(text, caret, { context: CONTEXT, elements });

test('nothing is offered outside a $ token', () => {
  assert.equal(at('1 + 2'), undefined);
  assert.equal(at('"plain string"'), undefined);
});

test('top level offers the runtime bindings', () => {
  const labels = at('$')!.items.map((i) => i.label);
  assert.ok(labels.includes('components'));
  assert.ok(labels.includes('metadata'));
});

test('a partial name filters the list', () => {
  const items = at('$comp')!.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].insert, '$components');
});

test('nested keys complete with the full path', () => {
  const items = at('$components.AssetIntakeForm.data.')!.items;
  assert.deepEqual(items.map((i) => i.insert).sort(), [
    '$components.AssetIntakeForm.data.count',
    '$components.AssetIntakeForm.data.note',
    '$components.AssetIntakeForm.data.title',
  ]);
});

/* ── The preview is the point ────────────────────────────────────────────── */

test('each suggestion shows the value actually there', () => {
  const items = at('$components.AssetIntakeForm.data.')!.items;
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i.preview]));
  assert.equal(byLabel.title, '"Screen Runner capture"');
  assert.equal(byLabel.count, '3');
});

test('an empty array reads as empty, not as absent', () => {
  const items = at('$components.TicketTable.')!.items;
  assert.equal(items.find((i) => i.label === 'data')?.preview, '[ 0 items ]');
});

test('objects preview their keys', () => {
  const items = at('$components.')!.items;
  assert.match(items.find((i) => i.label === 'AssetIntakeForm')?.preview ?? '', /\{ data \}/);
});

// The real Asset Intake bug: visible before the expression is written.
test('a path that is not there says so instead of returning nothing', () => {
  const req = at('$components.AssetIntakeForm.data.assetCollection.');
  assert.ok(req, 'a missing base must still produce a response');
  assert.equal(req!.items.length, 1);
  assert.equal(req!.items[0].kind, 'missing');
  assert.match(req!.items[0].preview, /not found/);
});

test('null is a value, not a missing path', () => {
  const items = at('$components.AssetIntakeForm.data.')!.items;
  const note = items.find((i) => i.label === 'note');
  assert.equal(note?.kind, 'value');
  assert.notEqual(note?.kind, 'missing');
});

/* ── Beyond the snapshot ─────────────────────────────────────────────────── */

// Completing only components that already ran is backwards when you are writing
// the transform that will populate them.
test('design elements appear even with no value yet', () => {
  const items = at('$components.', undefined, [
    { name: 'AssetIntakeForm', type: 'Form' },
    { name: 'IntakePrepare', type: 'ActionButton' },
  ])!.items;
  const prepare = items.find((i) => i.label === 'IntakePrepare');
  assert.equal(prepare?.kind, 'element');
  assert.match(prepare?.preview ?? '', /ActionButton/);
  // The live one keeps its real preview rather than being overwritten.
  assert.equal(items.find((i) => i.label === 'AssetIntakeForm')?.kind, 'object');
});

test('locals bound above the caret are in scope', () => {
  const text = '$me := $components.AssetIntakeForm; $m';
  const items = completionsAt(text, text.length, { context: CONTEXT })!.items;
  assert.ok(items.some((i) => i.label === 'me' && i.kind === 'local'));
  assert.ok(items.some((i) => i.label === 'metadata'));
});

/* ── Ranking and insertion ───────────────────────────────────────────────── */

test('exact-case matches rank above case-insensitive ones', () => {
  const items = completionsAt('$Comp', 5, { context: { Components: 1, components: 2 } })!.items;
  assert.equal(items[0].label, 'Components');
});

test('applying a completion replaces only the token', () => {
  const text = '$sum($comp)';
  const caret = 10;                       // just after `$comp`
  const req = completionsAt(text, caret, { context: CONTEXT })!;
  const out = applyCompletion(text, req, req.items[0]);
  assert.equal(out.text, '$sum($components)');
  assert.equal(out.caret, '$sum($components'.length);
});

/* ── `$.field` — paths into the document ──────────────────────────────────── */

// `$` is the mutation input in a model trigger and the payload in a flow expression, so
// `$.quantity` is the single most common thing to write. It used to resolve against the
// context root, fail, and report "nothing at this path" for every field of the very
// record being written about.
test('a document path completes against the payload', () => {
  const req = completionsAt('$.qu', 4, { context: {}, document: { quantity: 3, price: 2 } });
  assert.deepEqual(req?.items.map((i) => i.insert), ['$.quantity']);
});

test('every document field is offered with no prefix typed', () => {
  const req = completionsAt('$.', 2, { context: {}, document: { a: 1, b: 2 } });
  assert.deepEqual(req?.items.map((i) => i.label).sort(), ['a', 'b']);
});

test('nested document paths resolve', () => {
  const req = completionsAt('$.site.na', 9, { context: {}, document: { site: { name: 'Plant 1' } } });
  assert.deepEqual(req?.items.map((i) => i.insert), ['$.site.name']);
});

// Named bindings and the document are different roots; mixing them would offer paths
// that do not resolve.
test('a named binding still completes against the context', () => {
  const req = completionsAt('$bef', 4, { context: { before: { q: 1 } }, document: { q: 2 } });
  assert.deepEqual(req?.items.map((i) => i.insert), ['$before']);
});

test('no document means no document completions, rather than a crash', () => {
  assert.doesNotThrow(() => completionsAt('$.q', 3, { context: {} }));
  assert.deepEqual(completionsAt('$.q', 3, { context: {} })?.items, []);
});
