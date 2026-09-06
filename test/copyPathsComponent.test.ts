/**
 * Building the path you paste into a transform.
 *
 * Retyping `$components.AssetIntakeForm.disabled` by hand is where the silently-null
 * reads come from, so the button has to produce something the runtime can resolve —
 * or not appear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toComponentPath } from '../src/core/copyPaths';

test('an element and a property become a bound component path', () => {
  assert.equal(toComponentPath('AssetIntakeForm', 'disabled'), '$components.AssetIntakeForm.disabled');
});

test('an element alone is still referenceable', () => {
  assert.equal(toComponentPath('AssetIntakeForm'), '$components.AssetIntakeForm');
});

// `$components..disabled` resolves to nothing; no button is better than a broken one.
test('an unnamed or unquotable element offers no path', () => {
  assert.equal(toComponentPath(undefined, 'disabled'), undefined);
  assert.equal(toComponentPath('', 'disabled'), undefined);
  assert.equal(toComponentPath('My Form (v2)', 'disabled'), undefined);
});
