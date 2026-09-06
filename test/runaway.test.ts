/**
 * Runaway transforms, and telling a missing cache key from a feedback loop.
 *
 * Two failure modes with the same symptom — a transform re-running dozens of times
 * — and completely different fixes. Reporting them as one issue means the developer
 * hunts for a circular dependency that isn't there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../src/core/diagnose';
import { entryOwner } from '../src/core/designJoin';
import type { LogEntry } from '../src/core/types';

let seq = 0;
function entry(over: Partial<LogEntry> = {}): LogEntry {
  seq += 1;
  return {
    id: `e${seq}`, seq, ts: '10:00:00.000', epoch: 1_700_000_000_000 + seq * 50,
    kind: 'debug', title: 'transform', dur: '', write: 'components.SubmitButton.disabled',
    reads: [], level: 'debug', payload: [], after: 'false', ...over,
  };
}

/** Eight runs of one transform inside the loop window. */
const burst = (over: Partial<LogEntry> = {}) =>
  Array.from({ length: 8 }, () => entry(over));

test('a transform with no cache key is reported as such, not as a loop', () => {
  // `attribution` is the proof the design was consulted, which is what makes a
  // missing cacheKey mean "missing" rather than "unknown".
  const issues = diagnose(burst({ attribution: 'runtime', cacheKey: undefined }), []);
  const found = issues.find((i) => i.rule === 'transform-no-cache-key');
  assert.ok(found, 'expected a no-cache-key issue');
  assert.equal(found.severity, 'high');
  // One cause, one issue: also emitting transform-loop would double-report it.
  assert.equal(issues.filter((i) => i.rule === 'transform-loop').length, 0);
});

test('the issue names the element and the property, since that is what gets fixed', () => {
  const issues = diagnose(burst({ attribution: 'runtime', expr: '$state.x  >  0' }), []);
  const found = issues.find((i) => i.rule === 'transform-no-cache-key');
  assert.equal(found?.element, 'SubmitButton');
  assert.ok(found?.title.includes('SubmitButton.disabled'));
  // Collapsed whitespace: the expression is shown on one line in the pane.
  assert.equal(found?.expression, '$state.x > 0');
});

// Without the design, `cacheKey` is undefined for every entry — claiming the key is
// missing would be inventing a finding out of absent data.
test('with no design joined, the missing key is not claimed', () => {
  const issues = diagnose(burst({ attribution: undefined }), []);
  assert.equal(issues.filter((i) => i.rule === 'transform-no-cache-key').length, 0);
  assert.ok(issues.some((i) => i.rule === 'transform-loop'));
});

test('a transform that has a cache key and still loops is a loop', () => {
  const issues = diagnose(burst({ attribution: 'cacheKey', cacheKey: 'submitDisabled' }), []);
  assert.ok(issues.some((i) => i.rule === 'transform-loop'));
  assert.equal(issues.filter((i) => i.rule === 'transform-no-cache-key').length, 0);
});

test('a transform running a few times is not an issue at all', () => {
  const issues = diagnose([entry({ attribution: 'runtime' }), entry({ attribution: 'runtime' })], []);
  assert.equal(issues.filter((i) => i.rule.startsWith('transform-')).length, 0);
});

/* ── Attribution, which is what lets the panel outline the element ────────── */

test('the owning element comes off a component-scoped write', () => {
  assert.deepEqual(
    entryOwner({ write: 'components.SubmitButton.disabled', elementType: 'ActionButton' }),
    { name: 'SubmitButton', property: 'disabled', type: 'ActionButton' }
  );
});

// A query or a screen-level flow has no owning element; returning something here
// would make the panel outline an arbitrary element.
test('a write that names no component yields no owner', () => {
  assert.equal(entryOwner({ write: '(computed).url' }), undefined);
  assert.equal(entryOwner({ write: '' }), undefined);
  assert.equal(entryOwner({ write: 'components' }), undefined);
});
