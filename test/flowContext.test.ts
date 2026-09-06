/**
 * Hoisting what every flow node shares out of the per-node view.
 *
 * The `metadata` and `claims` objects below are verbatim from the Asset Intake
 * flow on admin.fuuz.app (2026-08-17) — identical on every node, which is the
 * whole reason this module exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByRoot, leafPaths, partitionNodeState, toAppConfigExpression, toStateExpression,
} from '../src/core/flowContext';

const METADATA = {
  tenantId: 'exampleTenantBuild',
  enterpriseId: 'fuuz-administration',
  flowId: 'syncBunnyAssets',
  versionId: 'cmsx7tizc0m2v019ob2ls8r00',
  deploymentId: 'cmsx7tizc0m2v019ob2ls8r00',
  dataFlowType: { id: 'Screen', dataFlowEnvironmentId: 'Web' },
  version: '0.0.7',
  logLevelId: 'Debug',
};
const CLAIMS = { userId: 'clblbguru000901stclxdf3d3', tenantId: 'exampleTenantBuild' };

const NODES = [
  { name: 'Get Bunny Libraries', state: { metadata: METADATA, claims: CLAIMS, payload: {} } },
  { name: 'Build Upsert Rows', state: { metadata: METADATA, claims: CLAIMS, payload: { updateAsset: [] } } },
  { name: 'Query Library Assets', state: { metadata: METADATA, claims: CLAIMS, payload: { upsertAsset: [1, 2] }, libraryId: 'lib-7' } },
];

/* ── Flattening ──────────────────────────────────────────────────────────── */

test('nested objects flatten to leaf paths', () => {
  const paths = leafPaths({ metadata: METADATA });
  assert.equal(paths.get('metadata.version'), '0.0.7');
  assert.equal(paths.get('metadata.dataFlowType.id'), 'Screen');
});

// A per-item diff would produce `rows.0.id`, which stops meaning anything as soon
// as the array length changes between runs.
test('arrays are compared whole, not per item', () => {
  const paths = leafPaths({ rows: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(paths.get('rows'), [{ id: 1 }, { id: 2 }]);
  assert.equal(paths.has('rows.0.id'), false);
});

test('an empty object is a leaf, not nothing', () => {
  assert.deepEqual([...leafPaths({ payload: {} }).keys()], ['payload']);
});

/* ── The partition ───────────────────────────────────────────────────────── */

test('metadata and claims are hoisted out of every node', () => {
  const p = partitionNodeState(NODES);
  const paths = p.global.map((g) => g.path);
  assert.ok(paths.includes('metadata.flowId'));
  assert.ok(paths.includes('metadata.dataFlowType.id'));
  assert.ok(paths.includes('claims.userId'));
  assert.ok(paths.includes('claims.tenantId'));
});

test('the hoisted values are carried, not just the paths', () => {
  const p = partitionNodeState(NODES);
  assert.equal(p.global.find((g) => g.path === 'metadata.version')?.value, '0.0.7');
});

test('a node is reduced to what is actually its own', () => {
  const p = partitionNodeState(NODES);
  const query = p.perNode.find((n) => n.name === 'Query Library Assets')!;
  assert.deepEqual(query.unique.map((u) => u.path).sort(), ['libraryId', 'payload.upsertAsset']);
});

test('a differing value stays on the node even when the path is shared', () => {
  const p = partitionNodeState(NODES);
  const build = p.perNode.find((n) => n.name === 'Build Upsert Rows')!;
  assert.ok(build.unique.some((u) => u.path === 'payload.updateAsset'),
    'payload differs per node, so it is not global');
  assert.equal(p.global.some((g) => g.path.startsWith('payload')), false);
});

// Present on some nodes but not others is NOT shared, however identical the
// values are where it appears — hoisting it claims a node has a field it lacks.
test('a path missing from one node is never hoisted', () => {
  const p = partitionNodeState([
    { name: 'a', state: { metadata: METADATA, extra: 'same' } },
    { name: 'b', state: { metadata: METADATA, extra: 'same' } },
    { name: 'c', state: { metadata: METADATA } },
  ]);
  assert.equal(p.global.some((g) => g.path === 'extra'), false);
  assert.ok(p.perNode.find((n) => n.name === 'a')!.unique.some((u) => u.path === 'extra'));
});

test('the saving is reported, since that is the point', () => {
  const p = partitionNodeState(NODES);
  assert.ok(p.savedPerNode >= 9, `only ${p.savedPerNode} paths hoisted`);
  assert.equal(p.comparable, true);
});

// With one node everything is trivially "shared" and the node would look empty.
test('one node is not treated as all nodes', () => {
  const p = partitionNodeState([NODES[0]]);
  assert.equal(p.comparable, false);
  assert.deepEqual(p.global, []);
  assert.ok(p.perNode[0].unique.some((u) => u.path === 'metadata.flowId'),
    'with nothing to compare, everything stays on the node');
});

test('no nodes at all is handled', () => {
  const p = partitionNodeState([]);
  assert.deepEqual(p.global, []);
  assert.deepEqual(p.perNode, []);
  assert.equal(p.comparable, false);
});

test('identical nodes leave nothing unique', () => {
  const p = partitionNodeState([
    { name: 'a', state: { metadata: METADATA } },
    { name: 'b', state: { metadata: METADATA } },
  ]);
  assert.deepEqual(p.perNode.flatMap((n) => n.unique), []);
});

/* ── App config as a shared object ───────────────────────────────────────── */

// Verbatim from the flow designer.
const APP_CONFIG = {
  applicationDefinitionVersion: {
    status: { default: { id: 'new', name: 'New' } },
    defaults: { initialVersionNumber: '0.0.0' },
  },
  applicationDefinitionVersionDeployment: {
    autoDeployEnvironments: [{ id: 'qa', name: 'QA' }, { id: 'build', name: 'Build' }],
  },
};

// `$appConfig` is not part of any node's state, so diffing nodes can never
// discover it as shared — it has to be declared singular.
test('the app config is global by construction, not by comparison', () => {
  const p = partitionNodeState(NODES, [{ root: 'appConfig', value: APP_CONFIG, prefix: '$appConfig' }]);
  const cfg = p.global.filter((g) => g.path.startsWith('appConfig.'));
  assert.ok(cfg.length >= 3, `only ${cfg.length} app config paths`);
  assert.equal(cfg.every((c) => c.shared === true), true, 'shared-by-construction must be marked');
  assert.equal(
    p.global.find((g) => g.path === 'appConfig.applicationDefinitionVersion.defaults.initialVersionNumber')?.value,
    '0.0.0'
  );
});

test('an array in the config stays whole', () => {
  const p = partitionNodeState(NODES, [{ root: 'appConfig', value: APP_CONFIG, prefix: '$appConfig' }]);
  const envs = p.global.find((g) => g.path.endsWith('autoDeployEnvironments'));
  assert.deepEqual(envs?.value, [{ id: 'qa', name: 'QA' }, { id: 'build', name: 'Build' }]);
});

// Observed-identical and singular-by-construction are different facts.
test('diffed globals are not marked shared', () => {
  const p = partitionNodeState(NODES, [{ root: 'appConfig', value: APP_CONFIG, prefix: '$appConfig' }]);
  assert.equal(p.global.find((g) => g.path === 'metadata.flowId')?.shared, undefined);
});

test('the app config survives a single node, where nothing is comparable', () => {
  const p = partitionNodeState([NODES[0]], [{ root: 'appConfig', value: APP_CONFIG, prefix: '$appConfig' }]);
  assert.equal(p.comparable, false);
  assert.ok(p.global.some((g) => g.path.startsWith('appConfig.')),
    'a singular object does not need a comparison to be global');
});

/* ── Copyable expressions ────────────────────────────────────────────────── */

// A bare path pasted into a node would silently evaluate to nothing.
test('a copied path is prefixed so it actually evaluates', () => {
  assert.equal(toStateExpression('metadata.flowId'), '$state.metadata.flowId');
  assert.equal(toAppConfigExpression('applicationDefinitionVersion.defaults.initialVersionNumber'),
    '$appConfig.applicationDefinitionVersion.defaults.initialVersionNumber');
});

test('paths group by root for rendering', () => {
  const groups = groupByRoot(partitionNodeState(NODES).global);
  assert.deepEqual(groups.map((g) => g.root), ['claims', 'metadata']);
  assert.ok(groups.find((g) => g.root === 'metadata')!.entries.length >= 7);
});
