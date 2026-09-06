/**
 * Subscription socket messages.
 *
 * Every input below is the shape the platform actually logs, at `console.error` —
 * which is why dozens of them were being grouped under `transform-error` and burying
 * the real findings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { churn, isSocketMessage, parseSocketMessage } from '../src/core/subscriptions';

const LINE = 'Subscription service socket error (cmsxgqfvz00033b6zz0ofgob2): io client disconnect';

test('the id and reason are read off the platform line', () => {
  const m = parseSocketMessage(LINE);
  assert.equal(m?.id, 'cmsxgqfvz00033b6zz0ofgob2');
  assert.equal(m?.reason, 'io client disconnect');
});

// `io client disconnect` is socket.io for "the client closed it deliberately".
test('a clean client close is benign', () => {
  assert.equal(parseSocketMessage(LINE)?.benign, true);
  assert.equal(parseSocketMessage('Subscription service socket error (x): transport close')?.benign, true);
});

test('a real connection failure is not', () => {
  assert.equal(parseSocketMessage('Subscription service socket error (x): transport error')?.benign, false);
  assert.equal(parseSocketMessage('Subscription service socket error (x): ping timeout')?.benign, false);
});

// A reason we have never seen is exactly where silence would be wrong.
test('an unknown reason is treated as a fault', () => {
  assert.equal(parseSocketMessage('Subscription service socket error (x): something new')?.benign, false);
});

// Over-matching would hide real errors, so anything unrecognised falls through.
test('an unrelated error is not a socket message', () => {
  assert.equal(isSocketMessage('Transform Error · disabled'), false);
  assert.equal(parseSocketMessage('socket error'), undefined);
});

test('a trailing full stop does not change the reason', () => {
  assert.equal(parseSocketMessage(`${LINE}.`)?.reason, 'io client disconnect');
});

/* ── Volume, which is the other half of the diagnosis ─────────────────────── */

// One clean close is nothing; the same id forty times is a resubscribe loop.
test('one id closing repeatedly is a loop', () => {
  const many = Array.from({ length: 8 }, () => parseSocketMessage(LINE)!);
  const v = churn(many);
  assert.equal(v.loop, true);
  assert.equal(v.worstCount, 8);
  assert.deepEqual(v.ids, ['cmsxgqfvz00033b6zz0ofgob2']);
});

test('several subscriptions each closing once is not', () => {
  const spread = ['a', 'b', 'c', 'd', 'e', 'f'].map(
    (id) => parseSocketMessage(`Subscription service socket error (${id}): io client disconnect`)!
  );
  assert.equal(churn(spread).loop, false);
});

// A fault anywhere in the run must not be masked by benign closes around it.
test('a fault reason wins over benign ones', () => {
  const mixed = [
    parseSocketMessage(LINE)!,
    parseSocketMessage('Subscription service socket error (y): ping timeout')!,
  ];
  assert.equal(churn(mixed).worstReason, 'ping timeout');
});
