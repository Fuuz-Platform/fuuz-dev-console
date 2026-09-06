/**
 * Parsing console-printed values into something traversable.
 *
 * Every input below is verbatim from the Asset Intake flow log on
 * admin.fuuz.app — including the console's own elisions, which are the whole
 * reason this needs care.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasElision, isElided, parseConsoleValue } from '../src/core/consoleValue';

test('unquoted keys parse, which JSON.parse cannot do', () => {
  assert.deepEqual(parseConsoleValue('{ payload: [] }'), { payload: [] });
  assert.deepEqual(parseConsoleValue('{ count: 3, ok: true }'), { count: 3, ok: true });
});

test('nested structures traverse', () => {
  assert.deepEqual(parseConsoleValue('{ a: { b: [1, 2] } }'), { a: { b: [1, 2] } });
});

/* ── Elisions: the part that must not lie ────────────────────────────────── */

// `Array(10)` means ten items the console declined to print. An empty array would
// say "this was empty" — the opposite conclusion, and a developer would act on it.
test('Array(n) becomes a marked elision, never an empty array', () => {
  const out = parseConsoleValue('{ payload: Array(10) }') as { payload: unknown };
  assert.equal(isElided(out.payload), true);
  assert.deepEqual(out.payload, { __elided: 'Array(10)', __count: 10 });
  assert.notDeepEqual(out.payload, []);
});

test('an all-elided object is not reported as empty', () => {
  const out = parseConsoleValue('{ asset: {…} }') as { asset: unknown };
  assert.deepEqual(out.asset, { __elided: '{…}' });
});

// `(8) [{…}, {…}]` prints fewer items than it states; reporting the printed count
// would understate the array.
test('a counted array keeps its stated length alongside the sample', () => {
  const out = parseConsoleValue('(8) [{…}, {…}]') as { __count?: number; sample?: unknown[] };
  assert.equal(out.__count, 8);
  assert.equal(out.sample?.length, 2);
});

test('a counted array printed in full stays a plain array', () => {
  assert.deepEqual(parseConsoleValue('(2) [1, 2]'), [1, 2]);
});

test('partial values are detectable, so the UI can say so', () => {
  assert.equal(hasElision(parseConsoleValue('{ a: { b: Array(4) } }')), true);
  assert.equal(hasElision(parseConsoleValue('{ a: { b: [1] } }')), false);
});

/* ── Scalars and strings ─────────────────────────────────────────────────── */

test('quoted strings keep their contents', () => {
  assert.deepEqual(parseConsoleValue('{ title: "Screen Runner capture" }'),
    { title: 'Screen Runner capture' });
});

test('null, booleans and numbers keep their types', () => {
  assert.deepEqual(parseConsoleValue('{ a: null, b: false, c: -2.5 }'),
    { a: null, b: false, c: -2.5 });
});

// A plain label must not become a one-character object.
test('a non-structure is returned unchanged', () => {
  assert.equal(parseConsoleValue('Confirm Sync'), 'Confirm Sync');
  assert.equal(parseConsoleValue('   '), undefined);
});

/* ── Robustness: the input is unreliable by definition ───────────────────── */

test('truncated input does not throw', () => {
  for (const text of ['{ a: ', '{ a: [1,', '(8) [', '{{{{', '[[[[']) {
    assert.doesNotThrow(() => parseConsoleValue(text), text);
  }
});

test('real rows from the flow log parse', () => {
  assert.deepEqual(parseConsoleValue('{ updateAsset: [] }'), { updateAsset: [] });
  const upsert = parseConsoleValue('{ upsertAssetCollection: Array(13) }') as Record<string, unknown>;
  assert.equal((upsert.upsertAssetCollection as { __count?: number }).__count, 13);
});
