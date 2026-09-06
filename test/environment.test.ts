/**
 * The production gate.
 *
 * These assertions are the control itself, not documentation of it — a change
 * that quietly reclassifies a production host as permitted must fail here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEnvironment, GATED_CAPABILITIES, isGated, mutationsAllowed, refusalFor,
} from '../src/core/environment';

/* ── Classification ──────────────────────────────────────────────────────── */

test('build and QA environments are permitted', () => {
  for (const url of [
    'https://build.mfgx.fuuz.app/app/wms',
    'https://api.build.proveit.fuuz.app/application',
    'https://qa.acme.fuuz.app/x',
    'https://staging.acme.fuuz.app/x',
    'https://uat.acme.fuuz.app/x',
    'https://sandbox.acme.fuuz.app/x',
  ]) {
    assert.equal(classifyEnvironment(url).tier, 'permitted', url);
    assert.equal(mutationsAllowed(url), true, url);
  }
});

test('the administration tenant is permitted by explicit decision', () => {
  const env = classifyEnvironment('https://admin.fuuz.app/system/configuration/screens/abc/run');
  assert.equal(env.tier, 'permitted');
  assert.equal(env.slug, 'admin');
});

test('a plain tenant host is production', () => {
  for (const url of ['https://mfgx.fuuz.app/app/wms', 'https://acme.fuuz.app/']) {
    const env = classifyEnvironment(url);
    assert.equal(env.tier, 'production', url);
    assert.equal(mutationsAllowed(url), false, url);
  }
});

// A substring test would let this through; segments are matched exactly.
test('a lookalike slug does not qualify as build', () => {
  for (const url of [
    'https://buildx.mfgx.fuuz.app/x',
    'https://prebuild.acme.fuuz.app/x',
    'https://devious.acme.fuuz.app/x',
    'https://adminx.fuuz.app/x',
  ]) {
    assert.equal(classifyEnvironment(url).tier, 'production', url);
  }
});

test('a lookalike domain is off-platform, never permitted', () => {
  for (const url of [
    'https://build.fuuz.app.evil.com/',
    'https://fuuz.app.attacker.test/',
    'https://admin.fuuz.app.evil.com/',
    'https://evil.example.com/',
  ]) {
    const env = classifyEnvironment(url);
    assert.equal(env.tier, 'off-platform', url);
    assert.equal(mutationsAllowed(url), false, url);
  }
});

// Failing open on an unparseable URL would make the gate decorative.
test('an unusable URL is refused, not waved through', () => {
  for (const url of ['', 'not a url', 'javascript:alert(1)', 'about:blank']) {
    assert.equal(mutationsAllowed(url), false, JSON.stringify(url));
  }
});

/* ── Capability set ──────────────────────────────────────────────────────── */

test('every mutating or capturing capability is gated', () => {
  for (const cap of ['applyElementStyle', 'callElementFn', 'captureTab', 'evaluateRemote']) {
    assert.equal(isGated(cap), true, cap);
  }
});

test('read-only capabilities are not gated', () => {
  for (const cap of [
    'highlight', 'clearHighlight', 'getSessionToken', 'getElementStyles',
    'probeElement', 'getElementRect', 'getDesignerSurface',
  ]) {
    assert.equal(isGated(cap), false, cap);
  }
});

test('a refusal names the environment and what was refused', () => {
  const msg = refusalFor('https://mfgx.fuuz.app/app/wms', 'captureTab');
  assert.match(msg, /Screenshots are disabled/);
  assert.match(msg, /mfgx/);
});

test('the gated list has no accidental members', () => {
  // `writeDefinition` was added deliberately (2026-08-19) when the console gained the
  // ability to write screen and flow definitions back to the platform. It is the only
  // capability here that outlives a reload, so if it ever drops off this list that is
  // a regression worth failing loudly for.
  assert.deepEqual([...GATED_CAPABILITIES].sort(),
    ['applyElementStyle', 'callElementFn', 'captureTab', 'evaluateRemote', 'writeDefinition']);
});
