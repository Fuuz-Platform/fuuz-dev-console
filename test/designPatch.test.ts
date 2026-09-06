/**
 * Patching a screen or flow definition.
 *
 * The screen fixture is a real pushed design, so the craft-graph shape under test is
 * the platform's own rather than a hand-made stand-in. The cases that matter most are
 * the refusals: this writes to the definition the native UI reads, so "wrote to the
 * wrong element" is a failure a user cannot see and cannot undo from here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchScreenDesign, patchFlowVersion, describeChange, isTransform } from '../src/core/designPatch';
import { screenDesignUpdate, flowVersionUpdate, hasMoved } from '../src/core/designWrite';

const fixture = (name: string): unknown => {
  const path = [join(__dirname, 'fixtures', name), join(__dirname, '..', '..', 'test', 'fixtures', name)].find(existsSync);
  return JSON.parse(readFileSync(path!, 'utf8'));
};

const PLAYER = () => fixture('screenDesign.assetPlayerDialog.json') as Record<string, any>;

const flowDoc = () => ({
  id: 'demoFlow', type: 'System', name: 'demoFlow', version: '1.0.0',
  nodes: [
    { id: 'n1', name: 'Request', type: 'request', data: { payload: {}, nextNodes: ['n2'] } },
    { id: 'n2', name: 'Query Readings', type: 'query', data: { model: 'Reading', variables: { line: 'L1' } } },
  ],
});

/* ── Screens ─────────────────────────────────────────────────────────────── */

test('patchScreenDesign writes a literal onto the addressed craft node', () => {
  const result = patchScreenDesign(PLAYER(), { nodeId: 'PlayerWrap00', property: 'height', value: '480px' });
  assert.ok(result.ok);
  const graph = (result.document as any).design.components[0].props.design;
  assert.equal(graph.PlayerWrap00.props.height, '480px');
  assert.equal(result.change.before, 'auto');
  assert.equal(result.change.kind, 'literal');
});

test('patchScreenDesign leaves the document it was given untouched', () => {
  // The caller still needs the original to compare against, and to re-read for the
  // has-it-moved check. Mutating it in place would quietly destroy both.
  const original = PLAYER();
  const before = JSON.stringify(original);
  patchScreenDesign(original, { nodeId: 'PlayerWrap00', property: 'height', value: '480px' });
  assert.equal(JSON.stringify(original), before);
});

test('patchScreenDesign stores a transform as the platform stores one', () => {
  const value = { __transform: '$components.Screen.context.url', __cacheKey: 'playerUrl', __remote: false };
  const result = patchScreenDesign(PLAYER(), { nodeId: 'PlayerFrame0', property: 'url', value });
  assert.ok(result.ok);
  assert.equal(result.change.kind, 'transform');
  const graph = (result.document as any).design.components[0].props.design;
  assert.ok(isTransform(graph.PlayerFrame0.props.url));
  assert.equal(graph.PlayerFrame0.props.url.__cacheKey, 'playerUrl');
});

test('patchScreenDesign preserves everything it does not touch', () => {
  const result = patchScreenDesign(PLAYER(), { nodeId: 'PlayerWrap00', property: 'height', value: '480px' });
  assert.ok(result.ok);
  const before = PLAYER().design.components[0].props.design;
  const after = (result.document as any).design.components[0].props.design;
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(after.PlayerFrame0, before.PlayerFrame0);
  assert.equal((result.document as any).screenId, PLAYER().screenId);
});

test('patchScreenDesign refuses a node id that is not in the design', () => {
  const result = patchScreenDesign(PLAYER(), { nodeId: 'NoSuchNode', property: 'height', value: '1px' });
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /No element with node id/);
});

test('patchScreenDesign refuses an edit with no target at all', () => {
  const result = patchScreenDesign(PLAYER(), { property: 'height', value: '1px' });
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /node id or an element name/);
});

test('patchScreenDesign refuses an ambiguous name rather than picking one', () => {
  const doc: any = PLAYER();
  const graph = doc.design.components[0].props.design;
  graph.Twin1 = { type: { resolvedName: 'Container' }, displayName: 'Twin', props: {} };
  graph.Twin2 = { type: { resolvedName: 'Container' }, displayName: 'Twin', props: {} };
  const result = patchScreenDesign(doc, { elementName: 'Twin', property: 'height', value: '1px' });
  assert.equal(result.ok, false);
  assert.deepEqual((result as any).candidates.sort(), ['Twin1', 'Twin2']);
});

test('patchScreenDesign refuses a document with no craft graph', () => {
  const result = patchScreenDesign({ design: {} }, { nodeId: 'x', property: 'y', value: 1 });
  assert.equal(result.ok, false);
  assert.match((result as any).reason, /craft graph/);
});

/* ── Flows ───────────────────────────────────────────────────────────────── */

test('patchFlowVersion writes into a node data path, creating intermediates', () => {
  const result = patchFlowVersion(flowDoc(), { nodeId: 'n2', path: 'variables.line', value: 'L2' });
  assert.ok(result.ok);
  const node = (result.document as any).nodes.find((n: any) => n.id === 'n2');
  assert.equal(node.data.variables.line, 'L2');
  assert.equal(result.change.before, 'L1');
  assert.equal(result.change.property, 'data.variables.line');
});

test('patchFlowVersion addresses a node by name when no id is given', () => {
  const result = patchFlowVersion(flowDoc(), { nodeName: 'Query Readings', path: 'model', value: 'Sample' });
  assert.ok(result.ok);
  assert.equal(result.change.target, 'n2');
});

test('patchFlowVersion refuses an ambiguous node name', () => {
  const doc: any = flowDoc();
  doc.nodes.push({ id: 'n3', name: 'Query Readings', type: 'query', data: {} });
  const result = patchFlowVersion(doc, { nodeName: 'Query Readings', path: 'model', value: 'x' });
  assert.equal(result.ok, false);
  assert.deepEqual((result as any).candidates, ['n2', 'n3']);
});

test('patchFlowVersion keeps every other node byte-identical', () => {
  const result = patchFlowVersion(flowDoc(), { nodeId: 'n2', path: 'model', value: 'Sample' });
  assert.ok(result.ok);
  const before = flowDoc().nodes[0];
  const after = (result.document as any).nodes[0];
  assert.deepEqual(after, before);
});

/* ── The requests, and the guard ─────────────────────────────────────────── */

test('the screen mutation targets the version, not the screen', () => {
  const req = screenDesignUpdate('ver-1', { design: {} }, 'x');
  assert.match(req.query, /updateScreenVersion/);
  assert.deepEqual((req.variables.p as any)[0].where, { id: 'ver-1' });
  assert.ok('design' in (req.variables.p as any)[0].update);
});

test('the flow mutation matches the shape the designer itself sends', () => {
  const req = flowVersionUpdate('ver-2', flowDoc(), 'x');
  assert.match(req.query, /updateDataFlowVersion\(payload:\$p\)/);
  assert.equal((req.variables.p as any)[0].update.flow.name, 'demoFlow');
});

test('hasMoved compares by value, because `number` only changes on publish', () => {
  const a = { design: { components: [1] } };
  assert.equal(hasMoved(a, { design: { components: [1] } }), false);
  assert.equal(hasMoved(a, { design: { components: [2] } }), true);
});

test('describeChange renders a line a person can approve', () => {
  const result = patchScreenDesign(PLAYER(), { nodeId: 'PlayerWrap00', property: 'height', value: '480px' });
  assert.ok(result.ok);
  assert.equal(describeChange(result.change), 'PlayerWrap00.height: "auto" → "480px"');
});

test('describeChange marks a transform as one rather than dumping its JSON', () => {
  const value = { __transform: '$now()', __cacheKey: 'ts' };
  const result = patchScreenDesign(PLAYER(), { nodeId: 'PlayerFrame0', property: 'url', value });
  assert.ok(result.ok);
  assert.match(describeChange(result.change), /ƒ \$now\(\)/);
});
