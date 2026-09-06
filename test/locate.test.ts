/**
 * Locating an element on a designer canvas and on a running screen.
 *
 * The bug these cover: highlighting worked in the designer and silently did
 * nothing at runtime, because every selector was keyed on `data-system-name` —
 * a designer-only attribute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeNames, climbToContainer, isApproximate, locateAttempts, pickAttributeHit,
} from '../src/core/locate';

test('the exact designer attribute is tried before anything else', () => {
  const [first] = locateAttempts({ name: 'AssetIntakeForm', type: 'Form' });
  assert.equal(first.selector, '[data-system-name="AssetIntakeForm"]');
});

// A running screen exposes the owning form and the bound field, not the name.
test('runtime attributes are attempted, so a running screen is locatable', () => {
  const selectors = locateAttempts({ name: 'AssetIntakeForm', dataPath: 'title' }).map((a) => a.selector);
  assert.ok(selectors.includes('[formelement="AssetIntakeForm"][field="title"]'));
  assert.ok(selectors.includes('[field="title"]'));
});

// A type selector matches every element of that kind, so it must rank last and
// must be reported as approximate — presenting it as exact points at the wrong
// element with full confidence.
test('type selectors come last and are marked approximate', () => {
  const attempts = locateAttempts({ name: 'Chart1', type: 'Chart' });
  const last = attempts[attempts.length - 1];
  assert.ok(isApproximate(last.via));
  assert.ok(attempts.findIndex((a) => isApproximate(a.via)) > 0);
});

test('a name with characters an id cannot hold does not produce a bad selector', () => {
  const selectors = locateAttempts({ name: 'My Form (v2)' }).map((a) => a.selector);
  assert.ok(!selectors.some((sel) => sel.startsWith('#')));
});

/* ── The attribute scan: the runtime fallback ─────────────────────────────── */

test('an attribute value naming the element matches, exactly or dotted', () => {
  assert.equal(attributeNames('AssetIntakeForm', 'AssetIntakeForm'), true);
  assert.equal(attributeNames('custom.AssetIntakeForm', 'AssetIntakeForm'), true);
});

// `Title` matching `TitleBarSubheading` would outline a different element and look
// like a working highlight, which is worse than no match at all.
test('a substring does not match', () => {
  assert.equal(attributeNames('TitleBarSubheading', 'Title'), false);
  assert.equal(attributeNames('', 'Title'), false);
});

// A hidden wrapper carries the name as readily as the visible element; outlining it
// draws a box of nothing.
test('zero-area hits are discarded', () => {
  const best = pickAttributeHit([
    { attr: 'id', depth: 3, area: 0 },
    { attr: 'data-x', depth: 9, area: 400 },
  ]);
  assert.equal(best?.attr, 'data-x');
});

test('nothing usable yields nothing, rather than a box of zero size', () => {
  assert.equal(pickAttributeHit([{ attr: 'id', depth: 1, area: 0 }]), undefined);
  assert.equal(pickAttributeHit([]), undefined);
});

test('a name-bearing attribute beats an incidental one', () => {
  const best = pickAttributeHit([
    { attr: 'data-something-else', depth: 2, area: 500 },
    { attr: 'data-element-name', depth: 8, area: 500 },
  ]);
  assert.equal(best?.attr, 'data-element-name');
});

// A name usually appears on a wrapper and is echoed by its children; the wrapper is
// the element the developer means.
test('among equals the outermost wins', () => {
  const best = pickAttributeHit([
    { attr: 'id', depth: 12, area: 300 },
    { attr: 'id', depth: 4, area: 300 },
  ]);
  assert.equal(best?.depth, 4);
});

/* ── Diagram nodes ────────────────────────────────────────────────────────── */

// A flow's definition and its canvas can disagree about a display name — the canvas may
// wrap or truncate it — while `data-nodeid` is the same string on both sides.
test('a diagram node id is tried before any name', () => {
  const [first] = locateAttempts({ nodeId: 'n2', name: 'For Each Library' });
  assert.equal(first.selector, '[data-nodeid="n2"]');
  assert.ok(!isApproximate(first.via));
});

test('with no id the name attempts still apply', () => {
  const selectors = locateAttempts({ name: 'FetchAssets' }).map((a) => a.selector);
  assert.ok(!selectors.some((s) => s.startsWith('[data-nodeid')));
  assert.ok(selectors.includes('#FetchAssets'));
});

/* ── Growing the outline to the field container ───────────────────────────── */

// A running screen marks the *control*, not the field — so an input's outline hugged the
// bare `<input>`, and on a select it could land beside the thing being pointed at.
test('the outline grows through wrappers that are genuinely bigger', () => {
  const levels = climbToContainer({ area: 100 }, [
    { area: 400, containsOther: false },
    { area: 900, containsOther: false },
  ]);
  assert.equal(levels, 2);
});

// The stop condition that matters: one outline around two fields is worse than one that is
// slightly too tight.
test('it never climbs past an ancestor holding another element', () => {
  const levels = climbToContainer({ area: 100 }, [
    { area: 400, containsOther: false },
    { area: 5000, containsOther: true },
  ]);
  assert.equal(levels, 1);
});

test('a wrapper that adds nothing is not the field container', () => {
  assert.equal(climbToContainer({ area: 100 }, [{ area: 104, containsOther: false }]), 0);
});

// An unbounded climb ends at `<body>`.
test('the climb is bounded', () => {
  const deep = Array.from({ length: 10 }, (_, i) => ({ area: 100 * (i + 2) ** 2, containsOther: false }));
  assert.equal(climbToContainer({ area: 100 }, deep), 4);
});

test('with no ancestors the element itself is outlined', () => {
  assert.equal(climbToContainer({ area: 100 }, []), 0);
});
