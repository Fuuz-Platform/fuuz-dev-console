/**
 * What counts as an element on a running screen.
 *
 * The DOM scrape finds what the renderer *marks*, and on a live screen that was the form fields
 * and little else — a chart, a button, a container simply never appeared. `$components` carries
 * every element, keyed by the name a transform would use, so it decides what exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWithComponents, type RuntimeElement } from '../src/core/runtimeElements';

const el = (name: string, type = 'TextInput', children: RuntimeElement[] = []): RuntimeElement => ({
  nodeId: name, name, type, via: 'formelement', children, origin: 'runtime', named: true, props: [],
});

const COMPONENTS = {
  AssetIntakeForm: { data: {} },
  TicketTable: { rows: [] },
  SubmitButton: {},
  HeaderCard: {},
};

test('every element the runtime knows about appears', () => {
  const merged = mergeWithComponents([el('AssetIntakeForm')], COMPONENTS);
  assert.deepEqual(
    merged.roots.map((r) => r.name).sort(),
    ['AssetIntakeForm', 'HeaderCard', 'SubmitButton', 'TicketTable']
  );
});

// The scrape's version is richer — it has a type and a bound path — so it must win.
test('a scraped element is not duplicated by its context entry', () => {
  const merged = mergeWithComponents([el('AssetIntakeForm')], COMPONENTS);
  const matches = merged.roots.filter((r) => r.name === 'AssetIntakeForm');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, 'TextInput');
  assert.equal(matches[0].via, 'formelement');
});

test('the counts say where the list came from', () => {
  const merged = mergeWithComponents([el('AssetIntakeForm')], COMPONENTS);
  assert.equal(merged.fromDom, 1);
  assert.equal(merged.fromContext, 3);
});

// A nested element found in the DOM is still "seen", or it would be listed twice — once in the
// tree and once flat.
test('nested scraped elements are matched, not re-added', () => {
  const tree = [el('Page', 'Container', [el('AssetIntakeForm')])];
  const merged = mergeWithComponents(tree, COMPONENTS);
  assert.equal(merged.roots.filter((r) => r.name === 'AssetIntakeForm').length, 0);
  assert.equal(merged.fromDom, 2);
});

// The runtime holds no state for it, which is a real answer — not a reason to hide it.
test('a DOM element absent from $components is kept', () => {
  const merged = mergeWithComponents([el('OnlyInDom')], { Other: {} });
  assert.ok(merged.roots.some((r) => r.name === 'OnlyInDom'));
});

// `$components` is a flat map: it says what exists, not what contains what. Inventing a
// hierarchy would be worse than showing a flat list.
test('context-only elements are flat and marked as such', () => {
  const merged = mergeWithComponents([], COMPONENTS);
  for (const node of merged.roots) {
    assert.deepEqual(node.children, []);
    assert.equal(node.via, '$components');
    // Named by the runtime itself, which is as authoritative as it gets.
    assert.equal(node.named, true);
    // No type is claimed, because the context does not carry one.
    assert.equal(node.type, 'Unknown');
  }
});

test('no capture yet leaves the scrape untouched', () => {
  const merged = mergeWithComponents([el('A')], undefined);
  assert.deepEqual(merged.roots.map((r) => r.name), ['A']);
  assert.equal(merged.fromContext, 0);
});

test('a malformed context does not throw or invent elements', () => {
  for (const input of [null, 'text', 42, [1, 2]]) {
    assert.doesNotThrow(() => mergeWithComponents([el('A')], input));
    assert.equal(mergeWithComponents([el('A')], input).fromContext, 0);
  }
});
