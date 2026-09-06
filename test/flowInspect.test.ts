/**
 * Inspecting a data flow: definition joined to the console's execution log.
 *
 * Every string below is real — captured from the Asset Intake flow on
 * admin.fuuz.app (2026-08-17), including the platform's own elisions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFlowCards, flowSummary, orderNodes, parseFlowLogRow, type FlowNodeDef,
} from '../src/core/flowInspect';

/* ── Row parsing ─────────────────────────────────────────────────────────── */

test('a row yields its node and both payloads', () => {
  const hit = parseFlowLogRow(
    'Compute Stale Rows▶input: { asset: {…} }▶output: { payload: [] }▶more: { inputState: {…} }',
    'result'
  );
  assert.equal(hit?.node, 'Compute Stale Rows');
  assert.equal(hit?.exec.input, '{ asset: {…} }');
  assert.equal(hit?.exec.output, '{ payload: [] }');
  assert.equal(hit?.exec.level, 'result');
});

// The console elides what it prints; implying we hold the whole payload would be
// a lie the `▶more` expander could disprove.
test('the platform’s own elisions are flagged', () => {
  assert.equal(parseFlowLogRow('X▶output: { payload: Array(10) }')?.exec.elided, true);
  assert.equal(parseFlowLogRow('X▶output: (8) [{…}, {…}]')?.exec.elided, true);
  assert.equal(parseFlowLogRow('X▶input: { payload: [] }')?.exec.elided, false);
});

test('a node with no input still parses', () => {
  const hit = parseFlowLogRow('Collect Libraries▶output: (8) [{…}, {…}]▶more: { inputState: […] }');
  assert.equal(hit?.node, 'Collect Libraries');
  assert.equal(hit?.exec.input, undefined);
  assert.ok(hit?.exec.output);
});

test('the terminal node’s response segment is kept', () => {
  const hit = parseFlowLogRow('Response▶input: (8) [{…}]▶output: (8) [{…}]▶response: { libraries: 8 }');
  assert.equal(hit?.exec.response, '{ libraries: 8 }');
});

// "Firing debug source node Source" names no I/O and is not an execution.
test('a bare status line is not mistaken for an execution', () => {
  assert.equal(parseFlowLogRow('Firing debug source node Source'), undefined);
  assert.equal(parseFlowLogRow('21 LogsStick to bottom'), undefined);
  assert.equal(parseFlowLogRow('   '), undefined);
});

test('an unparseable segment does not discard the row', () => {
  const hit = parseFlowLogRow('X▶input: { a: 1 }▶garbage-with-no-colon');
  assert.equal(hit?.exec.input, '{ a: 1 }');
});

/* ── Ordering ────────────────────────────────────────────────────────────── */

const DEFS: FlowNodeDef[] = [
  { id: 'source', name: 'Request', type: 'request', logic: [], nextNodes: ['confirmSync'] },
  { id: 'confirmSync', name: 'Confirm Sync', type: 'confirm', logic: ['data.titleTransform'], nextNodes: ['getLibraries', 'declined'] },
  { id: 'declined', name: 'Declined', type: 'response', logic: ['data.responseTransform'] },
  { id: 'getLibraries', name: 'Get Bunny Libraries', type: 'http', logic: ['data.httpPathTransform'], nextNodes: ['buildRows'] },
  { id: 'buildRows', name: 'Build Upsert Rows', type: 'transform', logic: ['data.transform'] },
];

// Log order is parallel-interleaved; presenting the flow that way misrepresents it.
test('nodes are ordered by wiring, not by log position', () => {
  assert.deepEqual(orderNodes(DEFS).map((n) => n.def.id),
    ['source', 'confirmSync', 'getLibraries', 'buildRows', 'declined']);
});

test('depth follows the graph, for indenting', () => {
  const byId = Object.fromEntries(orderNodes(DEFS).map((n) => [n.def.id, n.depth]));
  assert.equal(byId.source, 0);
  assert.equal(byId.confirmSync, 1);
  assert.equal(byId.buildRows, 3);
});

test('the entry node is the one nothing points at', () => {
  assert.equal(orderNodes(DEFS)[0].def.id, 'source');
});

// Dropping a node because its wiring is unusual would hide it entirely.
test('an unreachable node is still listed', () => {
  const orphan: FlowNodeDef = { id: 'orphan', name: 'Orphan', type: 'transform', logic: [] };
  assert.ok(orderNodes([...DEFS, orphan]).some((n) => n.def.id === 'orphan'));
});

test('a cycle terminates instead of hanging', () => {
  const loop: FlowNodeDef[] = [
    { id: 'a', name: 'A', type: 'transform', logic: [], nextNodes: ['b'] },
    { id: 'b', name: 'B', type: 'transform', logic: [], nextNodes: ['a'] },
  ];
  assert.equal(orderNodes(loop).length, 2);
});

/* ── Cards ───────────────────────────────────────────────────────────────── */

// Real rows, including the repetition a broadcast produces.
const ROWS = [
  { text: 'Build Upsert Rows▶input: { updateAsset: [] }▶output: { payload: Array(10) }', level: 'result' },
  { text: 'Build Upsert Rows▶input: { updateAsset: [] }▶output: { payload: Array(13) }', level: 'result' },
  { text: 'Get Bunny Libraries▶input: {}▶output: { data: {…} }', level: 'result' },
  { text: 'Upsert Asset Collections▶input: { payload: [] }▶output: { upsertAssetCollection: [] }', level: 'result' },
];

test('a node that ran many times keeps every execution', () => {
  const cards = buildFlowCards(DEFS, ROWS);
  const build = cards.find((c) => c.name === 'Build Upsert Rows');
  assert.equal(build?.executions.length, 2, 'a broadcast runs a node once per branch');
  assert.match(build!.executions[1].output!, /Array\(13\)/);
});

// The most useful fact in a flow diagnosis: a branch was not taken.
test('a node that never ran is marked, not omitted', () => {
  const cards = buildFlowCards(DEFS, ROWS);
  const declined = cards.find((c) => c.name === 'Declined');
  assert.equal(declined?.defOnly, true);
  assert.equal(declined?.executions.length, 0);
});

// A logged node with no definition means the two views disagree — worth seeing.
test('a logged node absent from the definition is surfaced', () => {
  const cards = buildFlowCards(DEFS, ROWS);
  const extra = cards.find((c) => c.name === 'Upsert Asset Collections');
  assert.equal(extra?.logOnly, true);
  assert.equal(extra?.def, undefined);
});

test('the definition’s logic fields ride along for the detail panel', () => {
  const cards = buildFlowCards(DEFS, ROWS);
  assert.deepEqual(cards.find((c) => c.name === 'Confirm Sync')?.def?.logic, ['data.titleTransform']);
});

test('cards stay in wiring order', () => {
  assert.deepEqual(buildFlowCards(DEFS, ROWS).slice(0, 3).map((c) => c.name),
    ['Request', 'Confirm Sync', 'Get Bunny Libraries']);
});

test('the summary counts what ran and what did not', () => {
  const s = flowSummary(buildFlowCards(DEFS, ROWS));
  assert.equal(s.nodes, 6, '5 defined plus 1 log-only');
  assert.equal(s.ran, 3);
  // Request, Confirm Sync and Declined have no rows in ROWS — three, not two.
  assert.equal(s.neverRan, 3, 'Request, Confirm Sync and Declined never logged I/O');
  assert.equal(s.executions, 4);
  assert.equal(s.logOnly, 1);
});

test('no log at all still yields the full node list', () => {
  const cards = buildFlowCards(DEFS, []);
  assert.equal(cards.length, 5);
  assert.equal(flowSummary(cards).ran, 0);
});

test('no definition still yields cards from the log', () => {
  const cards = buildFlowCards([], ROWS);
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c) => c.logOnly));
});
