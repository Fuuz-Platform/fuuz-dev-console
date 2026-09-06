/**
 * Clicking a value to get the path that reads it.
 *
 * The two boxes root differently and the difference is not cosmetic: a payload path starts
 * `$.` because the payload is JSONata's document, while a top-level context key *is* a
 * binding name. Getting that backwards produces paths that look right and resolve to
 * nothing — the exact failure this exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertAt, pathFor, previewOf, searchPaths } from '../src/core/pathInsert';

test('a payload path starts at the document', () => {
  assert.equal(pathFor('document', ['quantity']), '$.quantity');
  assert.equal(pathFor('document', ['site', 'name']), '$.site.name');
});

test('a top-level context key is the binding name', () => {
  assert.equal(pathFor('bindings', ['state']), '$state');
  assert.equal(pathFor('bindings', ['state', 'orderId']), '$state.orderId');
});

// JSONata reads `a.0` as a field literally named `0`.
test('array indices are bracketed, not dotted', () => {
  assert.equal(pathFor('document', ['lines', 0, 'sku']), '$.lines[0].sku');
  assert.equal(pathFor('bindings', ['state', 'rows', 2]), '$state.rows[2]');
});

// `$.order id` is a syntax error; `$.["order id"]` resolves.
test('a key that is not an identifier is bracket-quoted', () => {
  assert.equal(pathFor('document', ['order id']), '$["order id"]');
  assert.equal(pathFor('bindings', ['odd key', 'a']), '$["odd key"].a');
});

test('a quote inside a key is escaped', () => {
  assert.equal(pathFor('document', ['say "hi"']), '$["say \\"hi\\""]');
});

test('the root itself is just $', () => {
  assert.equal(pathFor('document', []), '$');
  assert.equal(pathFor('bindings', []), '$');
});

/* ── Inserting at the caret ───────────────────────────────────────────────── */

test('text goes in where the caret is', () => {
  const { text, caret } = insertAt('a  b', 2, 2, '$x');
  assert.equal(text, 'a $x b');
  assert.equal(caret, 4);
});

test('a selection is replaced', () => {
  assert.equal(insertAt('$wrong', 0, 6, '$right').text, '$right');
});

// `$state.a$state.b` is not what anyone meant by two clicks.
test('a space is added rather than welding onto a word', () => {
  assert.equal(insertAt('$a', 2, 2, '$b').text, '$a $b');
  assert.equal(insertAt('$b', 0, 0, '$a').text, '$a $b');
});

// Punctuation is already a separator; adding a space would just be noise.
test('punctuation needs no space', () => {
  assert.equal(insertAt('()', 1, 1, '$x').text, '($x)');
  assert.equal(insertAt('', 0, 0, '$x').text, '$x');
});

test('an out-of-range caret does not throw or lose text', () => {
  assert.equal(insertAt('abc', 99, 99, '$x').text, 'abc $x');
  assert.equal(insertAt('abc', -5, -5, '$x').text, '$x abc');
});

/* ── Previews, so a row says what it holds ────────────────────────────────── */

test('a preview distinguishes the shapes you care about', () => {
  assert.equal(previewOf([1, 2, 3]), '[ 3 items ]');
  assert.equal(previewOf({ a: 1, b: 2, c: 3, d: 4 }), '{ a, b, c, … }');
  assert.equal(previewOf(null), 'null');
  assert.equal(previewOf(undefined), 'undefined');
  assert.equal(previewOf('hi'), '"hi"');
  assert.equal(previewOf(3), '3');
});

/* ── Searching the payload and context ────────────────────────────────────── */

const CAPTURE = {
  components: {
    TicketTable: { rows: [{ sku: 'LIB-002', title: 'Pump' }], libraryId: 'lib-1' },
    TitleField: { value: 'Pump' },
  },
  metadata: { tenantId: 'buildMfgx' },
};

test('a key search returns the full path, not just the key', () => {
  const hits = searchPaths(CAPTURE, 'bindings', 'libraryId');
  assert.deepEqual(hits.map((h) => h.path), ['$components.TicketTable.libraryId']);
});

// "Which element holds LIB-002" cannot be answered by a key search, and is just as common.
test('values are searchable too', () => {
  const hits = searchPaths(CAPTURE, 'bindings', 'LIB-002');
  assert.deepEqual(hits.map((h) => h.path), ['$components.TicketTable.rows[0].sku']);
  assert.equal(hits[0].on, 'value');
});

test('a value in more than one place returns all of them', () => {
  const paths = searchPaths(CAPTURE, 'bindings', 'Pump').map((h) => h.path);
  assert.ok(paths.includes('$components.TitleField.value'));
  assert.ok(paths.includes('$components.TicketTable.rows[0].title'));
});

// A top-level `title` is far likelier to be what you meant than the twelfth row's.
test('shallow matches rank first, and keys before values', () => {
  const hits = searchPaths({ title: 'x', deep: { deeper: { title: 'y' } } }, 'document', 'title');
  assert.equal(hits[0].path, '$.title');
});

// A container matching must not stop its contents from matching.
test('a matching branch is reported and still walked', () => {
  const paths = searchPaths({ data: { dataPath: 1 } }, 'document', 'data').map((h) => h.path);
  assert.deepEqual(paths, ['$.data', '$.data.dataPath']);
});

test('one row per path, even when key and value both match', () => {
  const hits = searchPaths({ pump: 'pump' }, 'document', 'pump');
  assert.equal(hits.length, 1);
});

test('the search is case-insensitive', () => {
  assert.equal(searchPaths(CAPTURE, 'bindings', 'tenantid').length, 1);
});

test('an empty query returns nothing rather than everything', () => {
  assert.deepEqual(searchPaths(CAPTURE, 'bindings', '   '), []);
});

// A search that walked a whole capture unbounded would block the panel on every keystroke.
test('results are bounded', () => {
  const wide = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`key${i}`, i]));
  assert.equal(searchPaths(wide, 'document', 'key', 20).length, 20);
});

test('a malformed or empty input does not throw', () => {
  for (const input of [undefined, null, 42, 'text', []]) {
    assert.doesNotThrow(() => searchPaths(input, 'document', 'x'));
  }
});
