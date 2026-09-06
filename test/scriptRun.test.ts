/**
 * Preparing and interpreting a script run.
 *
 * The binding convention is the part that matters: an expression that works in this
 * scratchpad has to work when pasted into the designer, or the tool is a trap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeExpression, parseInputs, toTransferable, wrapScript } from '../src/core/scriptRun';

test('empty inputs are objects, not errors', () => {
  const p = parseInputs('', '');
  assert.deepEqual(p.payload, {});
  assert.deepEqual(p.context, {});
  assert.equal(p.error, undefined);
});

// "Unexpected token }" without knowing which box is a guessing game.
test('a malformed input names its box', () => {
  assert.match(parseInputs('{oops', '{}').error ?? '', /^Payload/);
  assert.match(parseInputs('{}', '{oops').error ?? '', /^Context/);
});

test('a non-object context is refused, since its keys become bindings', () => {
  assert.match(parseInputs('{}', '[1,2]').error ?? '', /must be a JSON object/);
});

/* ── The wrapper ──────────────────────────────────────────────────────────── */

test('context keys become consts, so state.x reads like $state.x', () => {
  const src = wrapScript('return state.orderId;', ['state', 'metadata']);
  assert.match(src, /const state = context\["state"\]/);
  assert.match(src, /const metadata = context\["metadata"\]/);
});

// A key that is not an identifier would be a syntax error in the wrapper and take out
// the whole run.
test('a key that cannot be a variable name is skipped', () => {
  const src = wrapScript('return 1;', ['ok', 'not-ok', '2bad']);
  assert.match(src, /const ok =/);
  assert.ok(!src.includes('not-ok ='));
  assert.ok(!src.includes('2bad ='));
});

// Typing `payload.items.length` and seeing undefined makes the tool feel broken.
test('a bare expression is returned', () => {
  assert.equal(looksLikeExpression('payload.items.length'), true);
  assert.match(wrapScript('payload.items.length', []), /return \(payload\.items\.length\);/);
});

// Guessing where to insert a return in real code would be wrong more often than right.
test('a program is left alone', () => {
  assert.equal(looksLikeExpression('const x = 1; return x;'), false);
  assert.equal(looksLikeExpression('if (a) return 1;'), false);
  assert.equal(looksLikeExpression('return 1'), false);
  assert.equal(looksLikeExpression(''), false);
});

/* ── Making a result transferable ─────────────────────────────────────────── */

// Losing the answer to a serialisation failure is the worst outcome available.
test('values that cannot cross postMessage become readable markers', () => {
  assert.equal(toTransferable(() => 1), '[Function anonymous]');
  assert.equal(toTransferable(10n), '10n');
  assert.deepEqual(toTransferable(new Error('boom')), { name: 'Error', message: 'boom' });
});

test('a circular object does not throw', () => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  assert.deepEqual(toTransferable(a), { name: 'a', self: '[circular]' });
});

test('maps and sets survive as data', () => {
  assert.deepEqual(toTransferable(new Map([['a', 1]])), { a: 1 });
  assert.deepEqual(toTransferable(new Set([1, 2])), [1, 2]);
});

test('undefined becomes null so it survives the trip', () => {
  assert.equal(toTransferable(undefined), null);
});
