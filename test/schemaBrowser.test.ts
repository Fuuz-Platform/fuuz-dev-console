/**
 * Canvas selection, and a model as a browsable tree.
 *
 * Introspection is the source rather than the canvas because the canvas shows the
 * schema *as drawn* and the API shows it *as deployed* — and when they disagree, the
 * disagreement is the bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulate, selectedNodes, selectionOf } from '../src/core/canvasSelection';
import { baseTypeName, filterModel, starterQuery, toModelShape, typeName } from '../src/core/modelTree';

/* ── Selection ────────────────────────────────────────────────────────────── */

test('every known selection marker is recognised, and reported', () => {
  assert.deepEqual(selectionOf({ id: '1', ariaSelected: 'true' }), { selected: true, via: 'aria-selected' });
  assert.deepEqual(selectionOf({ id: '1', dataSelected: 'true' }), { selected: true, via: 'data-selected' });
  assert.deepEqual(selectionOf({ id: '1', classes: 'node selected' }), { selected: true, via: 'class' });
});

// Both of these strings exist in this DOM, and neither means selected.
test('a word containing "selected" does not count', () => {
  assert.equal(selectionOf({ id: '1', classes: 'unselected' }).selected, false);
  assert.equal(selectionOf({ id: '1', classes: 'selectedNodesMessage' }).selected, false);
});

test('nothing selected reports no marker, which is diagnosable', () => {
  const s = selectedNodes([{ id: '1', name: 'Order' }, { id: '2', name: 'Asset' }]);
  assert.deepEqual(s.ids, []);
  assert.equal(s.via, undefined);
});

test('multi-select is kept, since the browser accumulates models', () => {
  const s = selectedNodes([
    { id: '1', name: 'Order', classes: 'selected' },
    { id: '2', name: 'Asset', ariaSelected: 'true' },
  ]);
  assert.deepEqual(s.names, ['Order', 'Asset']);
});

// Clicking a fourth model must not lose the first three.
test('models accumulate newest-first without duplicates', () => {
  assert.deepEqual(accumulate(['Asset'], ['Order']), ['Order', 'Asset']);
  assert.deepEqual(accumulate(['Order', 'Asset'], ['Order']), ['Order', 'Asset']);
});

test('the list is capped, so it stays a browser', () => {
  const many = Array.from({ length: 20 }, (_, i) => `M${i}`);
  assert.equal(accumulate([], many, 12).length, 12);
});

/* ── Model shape ──────────────────────────────────────────────────────────── */

const TYPE = {
  name: 'Order',
  kind: 'OBJECT',
  fields: [
    { name: 'id', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'ID' } } },
    { name: 'note', type: { kind: 'SCALAR', name: 'String' }, description: 'free text' },
    {
      name: 'lines',
      type: { kind: 'NON_NULL', ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', ofType: { kind: 'OBJECT', name: 'OrderLine' } } } },
    },
  ],
};

// Flattening the wrappers by hand puts the exclamation marks in the wrong places,
// which misreports whether a field is required.
test('nested type wrappers render the way GraphQL writes them', () => {
  assert.equal(typeName(TYPE.fields[2].type), '[OrderLine!]!');
  assert.equal(baseTypeName(TYPE.fields[2].type), 'OrderLine');
});

test('required, list and relation are read from the wrappers', () => {
  const shape = toModelShape(TYPE)!;
  const [id, note, lines] = shape.fields;
  assert.deepEqual([id.required, id.relation], [true, false]);
  assert.deepEqual([note.required, note.relation], [false, false]);
  assert.deepEqual([lines.required, lines.list, lines.relation], [true, true, true]);
});

test('the summary counts what you scan a model for', () => {
  assert.deepEqual(toModelShape(TYPE)!.summary, { fields: 3, relations: 1, required: 2 });
});

// A model the canvas draws but the API does not serve is a real answer.
test('a type that does not exist yields undefined', () => {
  assert.equal(toModelShape(null), undefined);
  assert.equal(toModelShape({ name: undefined }), undefined);
});

// Handing someone a query that will not compile is worse than a narrow one.
test('the starter query selects scalars only', () => {
  const q = starterQuery(toModelShape(TYPE)!);
  assert.ok(q.includes('orderCollection'));
  assert.ok(q.includes('id'));
  assert.ok(!q.includes('lines'));
});

/* ── Search ───────────────────────────────────────────────────────────────── */

// A model with every field hidden reads as an empty model, which is a different and
// much more alarming answer than "no fields matched".
test('a model matching by name is kept whole', () => {
  assert.equal(filterModel(toModelShape(TYPE)!, 'order')!.fields.length, 3);
});

test('otherwise only matching fields survive', () => {
  const filtered = filterModel(toModelShape(TYPE)!, 'note')!;
  assert.deepEqual(filtered.fields.map((f) => f.name), ['note']);
});

test('a type name and a description are searchable too', () => {
  assert.equal(filterModel(toModelShape(TYPE)!, 'OrderLine')?.fields.length, 1);
  assert.equal(filterModel(toModelShape(TYPE)!, 'free text')?.fields.length, 1);
});

test('no match drops the model rather than showing it empty', () => {
  assert.equal(filterModel(toModelShape(TYPE)!, 'zzz'), undefined);
});

/* ── Selection with no marker at all ──────────────────────────────────────── */

// Verified on a live schema canvas: four nodes, every one `class="node css-…"`, no
// `aria-selected`, no `data-selected`, no `.selected` — the selected node differs only by its
// generated emotion class. So the odd one out is the selection.
const peers = (signatures: string[]) =>
  signatures.map((signature, i) => ({ id: `M${i}`, name: `Model${i}`, signature }));

test('the node drawn differently from its peers is the selected one', () => {
  const picked = selectedNodes(peers(['a', 'a', 'a', 'b']));
  assert.deepEqual(picked.ids, ['M3']);
  assert.match(picked.via ?? '', /drawn differently/);
});

// The node id *is* the model name on a schema canvas, so a nameless node still resolves.
test('the id stands in for a missing name', () => {
  const picked = selectedNodes([
    { id: 'Asset', signature: 'b' },
    { id: 'Order', signature: 'a' },
    { id: 'Line', signature: 'a' },
    { id: 'Site', signature: 'a' },
  ]);
  assert.deepEqual(picked.names, ['Asset']);
});

test('an explicit marker still wins over the inference', () => {
  const picked = selectedNodes([
    { id: 'M0', name: 'A', signature: 'a', ariaSelected: 'true' },
    { id: 'M1', name: 'B', signature: 'b' },
    { id: 'M2', name: 'C', signature: 'a' },
  ]);
  assert.deepEqual(picked.ids, ['M0']);
  assert.equal(picked.via, 'aria-selected');
});

/* ── When "the odd one out" means nothing ─────────────────────────────────── */

// With two nodes, "minority" is a coin toss.
test('too few nodes to infer anything', () => {
  assert.deepEqual(selectedNodes(peers(['a', 'b'])).ids, []);
});

test('all alike means nothing is selected', () => {
  assert.deepEqual(selectedNodes(peers(['a', 'a', 'a', 'a'])).ids, []);
});

// An even split is not a selection, and saying so beats picking one.
test('an even split infers nothing', () => {
  assert.deepEqual(selectedNodes(peers(['a', 'a', 'b', 'b'])).ids, []);
});

// Half the canvas drawn differently is two kinds of node, not a selection.
test('too large a minority is a category, not a selection', () => {
  assert.deepEqual(selectedNodes(peers(['a', 'a', 'a', 'b', 'b', 'b'])).ids, []);
});

test('nodes with no signature at all infer nothing', () => {
  assert.deepEqual(selectedNodes([{ id: 'a' }, { id: 'b' }, { id: 'c' }]).ids, []);
});
