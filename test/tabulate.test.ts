/**
 * A GraphQL response as a spreadsheet.
 *
 * Two things must not go wrong: picking the wrong array (a table of the wrong thing),
 * and dropping a column because the first row happened not to have it (silent data
 * loss that looks like a complete table).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellText, findArrays, flattenRecord, preferredArray, tabulate, toTsv } from '../src/core/tabulate';

const RESPONSE = {
  assetCollection: [
    { id: '1', name: 'Pump', site: { name: 'Plant 1' } },
    { id: '2', name: 'Valve', site: { name: 'Plant 2' }, notes: 'spare' },
  ],
};

test('rows come from the array, wherever it is nested', () => {
  const t = tabulate(RESPONSE);
  assert.equal(t?.path, 'assetCollection');
  assert.equal(t?.rows.length, 2);
});

// GraphQL omits nulls, so row 1 having no `notes` while row 2 does is routine. Using
// row 1's keys would drop the column and the value with it.
test('columns are the union of every row, not the first row', () => {
  const t = tabulate(RESPONSE);
  assert.ok(t?.columns.includes('notes'));
  assert.equal(t?.rows[0][t.columns.indexOf('notes')], undefined);
  assert.equal(t?.rows[1][t.columns.indexOf('notes')], 'spare');
});

// A relation always arrives nested; a column reading [object Object] answers nothing.
test('a relation is flattened one level', () => {
  const t = tabulate(RESPONSE);
  assert.ok(t?.columns.includes('site.name'));
  assert.equal(t?.rows[0][t.columns.indexOf('site.name')], 'Plant 1');
});

test('a deeper object stays whole rather than exploding the columns', () => {
  const flat = flattenRecord({ a: { b: { c: 1 } } });
  assert.deepEqual(flat, { a: { b: { c: 1 } } });
});

test('the longest array wins, and every candidate is offered', () => {
  const many = { small: [{ a: 1 }], big: [{ a: 1 }, { a: 2 }, { a: 3 }] };
  assert.equal(preferredArray(findArrays(many)), 'big');
  assert.equal(tabulate(many)?.alternatives.length, 2);
});

test('an explicit pick overrides the guess', () => {
  const many = { small: [{ a: 1 }], big: [{ a: 1 }, { a: 2 }] };
  assert.equal(tabulate(many, 'small')?.path, 'small');
});

// An empty grid would imply an empty result; the JSON view has the real answer.
test('nothing tabular yields undefined, not an empty table', () => {
  assert.equal(tabulate({ ok: true }), undefined);
  assert.equal(tabulate({ rows: [] }), undefined);
  assert.equal(tabulate(null), undefined);
});

test('a list of scalars is a one-column table', () => {
  const t = tabulate({ ids: ['a', 'b'] });
  assert.deepEqual(t?.columns, ['value']);
  assert.deepEqual(t?.rows, [['a'], ['b']]);
});

// The difference is usually what is being diagnosed.
test('absent and null render differently', () => {
  assert.equal(cellText(undefined), '');
  assert.equal(cellText(null), 'null');
});

test('TSV survives a tab inside a value', () => {
  const t = tabulate({ rows: [{ a: 'x\ty' }] })!;
  assert.equal(toTsv(t).split('\n')[1], 'x y');
});
