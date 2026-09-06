/**
 * Static findings over the design.
 *
 * The headline case is real: the deployed Asset Intake screen base64-encodes
 * HTML containing em-dashes and bullets, which `btoa` cannot represent — so the
 * uploader URL could never be produced. That was found at runtime the hard way;
 * these rules find it without running anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexScreenDesign } from '../src/core/designJoin';
import { lintDesign } from '../src/core/designLint';
import { diffState, leaves } from '../src/core/stateDiff';
import type { StateNode } from '../src/core/types';

const craft = (nodes: Record<string, unknown>) => ({
  name: 'Test Screen', version: '1.0.0',
  design: { components: [{ name: 'Test Screen', type: 'canvas', props: { design: nodes } }] },
});

const node = (elementName: string, resolvedName: string, props: Record<string, unknown>) => ({
  type: { resolvedName }, custom: { elementName }, props,
});

const dyn = (transform: string, cacheKey = '') => ({ __transform: transform, __cacheKey: cacheKey, __remote: false });

const lint = (nodes: Record<string, unknown>) => {
  const doc = craft(nodes);
  return lintDesign(indexScreenDesign(doc), doc);
};

test('base64-non-latin1: catches btoa over characters it cannot encode', () => {
  const found = lint({
    a: node('TusUploader', 'EmbeddedWebpage', {
      url: dyn('$base64encode("<!doctype html> — bullet • ellipsis …")'),
    }),
  });
  const issue = found.find((f) => f.rule === 'base64-non-latin1');
  assert.ok(issue, 'the btoa defect was missed');
  assert.equal(issue.severity, 'high');
  assert.equal(issue.count, 3);
  assert.match(issue.detail, /InvalidCharacterError/);
  assert.match(issue.title, /TusUploader\.url/);
});

test('base64-non-latin1: plain ASCII is fine', () => {
  const found = lint({ a: node('Frame', 'EmbeddedWebpage', { url: dyn('$base64encode("<!doctype html><p>hello</p>")') }) });
  assert.equal(found.filter((f) => f.rule === 'base64-non-latin1').length, 0);
});

test('unknown-component-ref: flags a reference no element satisfies', () => {
  const found = lint({
    a: node('Button', 'ActionButton', { disabled: dyn('$not($exists($components.GhostForm.data))') }),
  });
  const issue = found.find((f) => f.rule === 'unknown-component-ref');
  assert.ok(issue);
  assert.match(issue.detail, /GhostForm/);
});

test('unknown-component-ref: a reference to a real sibling is not flagged', () => {
  const found = lint({
    a: node('Button', 'ActionButton', { disabled: dyn('$exists($components.RealForm.data)') }),
    b: node('RealForm', 'Form', {}),
  });
  assert.equal(found.filter((f) => f.rule === 'unknown-component-ref').length, 0);
});

test('column-width-string and unknown-column-type mirror what AG Grid warns at runtime', () => {
  const found = lint({
    a: node('Col1', 'TableColumn', { width: '110', type: 'url' }),
    b: node('Col2', 'TableColumn', { width: 110, type: 'text' }),
  });
  assert.ok(found.some((f) => f.rule === 'column-width-string' && f.title.includes('Col1')));
  assert.ok(found.some((f) => f.rule === 'unknown-column-type' && f.title.includes('url')));
  // The correctly-typed column must not be flagged.
  assert.ok(!found.some((f) => f.title.includes('Col2')));
});

test('duplicate-cache-key: reports the ambiguity that defeats attribution', () => {
  const found = lint({
    a: node('ColA', 'TableColumn', { linkTarget: dyn('{ "url": data.x }', 'shareUrlLink') }),
    b: node('ColB', 'TableColumn', { linkTarget: dyn('{ "url": data.y }', 'shareUrlLink') }),
  });
  const issue = found.find((f) => f.rule === 'duplicate-cache-key');
  assert.ok(issue);
  assert.equal(issue.count, 2);
});

test('a clean design produces no findings', () => {
  assert.deepEqual(lint({ a: node('Form', 'Form', { title: dyn('"ok"') }) }), []);
});

/* ── State diff ──────────────────────────────────────────────────────────── */

const tree = (values: Record<string, string>): StateNode[] => [{
  id: 'root', label: 'Screen', type: 'x', vk: 'obj', trace: [], changed: false,
  children: Object.entries(values).map(([id, value]) => ({
    id, label: id, type: 'string', value, vk: 'str', trace: [], changed: false,
  })),
}];

test('leaves: collects only value-bearing leaves', () => {
  assert.deepEqual([...leaves(tree({ 'a.b': '1', 'a.c': '2' })).keys()], ['a.b', 'a.c']);
});

test('diffState: reports added, changed and removed, in that order', () => {
  const changes = diffState(tree({ keep: '1', gone: '2', edit: 'before' }), tree({ keep: '1', edit: 'after', fresh: '9' }));
  assert.deepEqual(changes, [
    { path: 'fresh', kind: 'added', after: '9' },
    { path: 'edit', kind: 'changed', before: 'before', after: 'after' },
    { path: 'gone', kind: 'removed', before: '2' },
  ]);
});

test('diffState: identical snapshots differ in nothing', () => {
  assert.deepEqual(diffState(tree({ a: '1' }), tree({ a: '1' })), []);
});
