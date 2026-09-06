/**
 * Detecting a designer-tab switch.
 *
 * The Application Designer swaps a screen for a flow with no navigation and no
 * reconnect, so this comparison is the only thing standing between the developer
 * and a flow tab showing the previous screen's structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCanvas, surfaceChanged, surfaceIdentity, tabForCanvas } from '../src/core/surface';

test('a kind and an id identify the surface', () => {
  assert.equal(surfaceIdentity({ designer: 'flow', designerId: 'abc' }), 'flow:abc');
});

test('outside a designer there is no surface', () => {
  assert.equal(surfaceIdentity({ designer: null }), undefined);
  assert.equal(surfaceIdentity(undefined), undefined);
  assert.equal(surfaceIdentity({}), undefined);
});

// Keying on kind alone would leave the first screen's design on display after
// switching to the second — the exact bug, one step subtler.
test('two screens in two tabs are two surfaces', () => {
  const a = surfaceIdentity({ designer: 'screen', tabId: 't1' });
  const b = surfaceIdentity({ designer: 'screen', tabId: 't2' });
  assert.notEqual(a, b);
  assert.equal(surfaceChanged(a, b), true);
});

test('a screen and a flow are two surfaces', () => {
  assert.equal(
    surfaceChanged(surfaceIdentity({ designer: 'screen', tabId: 't1' }),
      surfaceIdentity({ designer: 'flow', designerId: 'f1' })),
    true
  );
});

// A reset on every poll would clear the developer's expanded rows four times a
// second, which is worse than never resetting.
test('the same tab polled again is not a switch', () => {
  const report = { designer: 'screen', tabId: 't1', tabName: 'Asset Intake' };
  assert.equal(surfaceChanged(surfaceIdentity(report), surfaceIdentity({ ...report })), false);
});

// The flow canvas carries the flow's own id; prefer it over the tab id, which is
// only an ordering handle.
test('the most stable id available wins', () => {
  assert.equal(surfaceIdentity({ designer: 'flow', designerId: 'f1', tabId: 't9' }), 'flow:f1');
  assert.equal(surfaceIdentity({ designer: 'screen', tabName: 'Asset Intake' }), 'screen:Asset Intake');
});

/* ── Flapping, which the scrape makes real ────────────────────────────────── */

// A poll landing mid-render can report the kind without the id. Remounting on that
// would wipe the developer's expanded rows several times a second.
test('losing the id is not a switch', () => {
  assert.equal(surfaceChanged('screen:t1', 'screen:'), false);
  assert.equal(surfaceChanged('screen:', 'screen:t1'), false);
});

test('but a change of kind always is', () => {
  assert.equal(surfaceChanged('screen:', 'flow:'), true);
  assert.equal(surfaceChanged('screen:t1', 'flow:t1'), true);
});

test('entering or leaving a designer is a switch', () => {
  assert.equal(surfaceChanged(undefined, 'screen:t1'), true);
  assert.equal(surfaceChanged('screen:t1', undefined), true);
});

/* ── Several canvases at once, which is the normal case ───────────────────── */

// The designer keeps every open tab mounted and hides the inactive ones, so a document
// holds a screen canvas, a schema canvas and a flow canvas simultaneously. Taking the
// first in a fixed order made a flow unreadable whenever a screen tab was also open.
test('the visible canvas wins over a hidden one', () => {
  const chosen = pickCanvas([
    { kind: 'screen', visible: false, area: 0 },
    { kind: 'flow', designerId: 'f1', visible: true, area: 800_000 },
  ]);
  assert.equal(chosen?.kind, 'flow');
});

test('order in the list carries no authority', () => {
  const chosen = pickCanvas([
    { kind: 'flow', visible: true, area: 500 },
    { kind: 'screen', visible: false, area: 900_000 },
  ]);
  assert.equal(chosen?.kind, 'flow');
});

// A canvas that claims to be visible but has no box is no more use than a hidden one.
test('a zero-area canvas does not count as visible', () => {
  const chosen = pickCanvas([
    { kind: 'screen', visible: true, area: 0 },
    { kind: 'flow', visible: true, area: 1000 },
  ]);
  assert.equal(chosen?.kind, 'flow');
});

// Calling it "no designer" would be wrong: the developer is plainly in one.
test('with nothing visible the largest is still reported', () => {
  const chosen = pickCanvas([
    { kind: 'screen', visible: false, area: 10 },
    { kind: 'schema', visible: false, area: 5000 },
  ]);
  assert.equal(chosen?.kind, 'schema');
});

test('no canvases means no designer', () => {
  assert.equal(pickCanvas([]), undefined);
});

/* ── Which tab owns the canvas ────────────────────────────────────────────── */

const TABS = [
  { id: 'tScreen', kind: 'screen' },
  { id: 'f1', kind: 'flow' },
  { id: 'f2', kind: 'flow' },
];

// Kind alone is ambiguous with two flows open; the flow canvas carries its own id.
test('a canvas with an id names its tab exactly', () => {
  assert.equal(tabForCanvas(TABS, { kind: 'flow', designerId: 'f2' })?.id, 'f2');
});

test('without an id the kind is the best available answer', () => {
  assert.equal(tabForCanvas(TABS, { kind: 'screen' })?.id, 'tScreen');
});

// An id that matches nothing must not silently pick an unrelated tab of another kind.
test('an unknown id falls back within the same kind', () => {
  assert.equal(tabForCanvas(TABS, { kind: 'flow', designerId: 'nope' })?.kind, 'flow');
});

test('no canvas means no tab', () => {
  assert.equal(tabForCanvas(TABS, undefined), undefined);
});
