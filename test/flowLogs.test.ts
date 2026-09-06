/**
 * Reading the flow designer's log from the store.
 *
 * The fixtures mirror the real slice shape: `dataFlowEditor` keyed by designer tab,
 * each tab holding `logs: [{id, level, nodeId, message, data}]` with a cuid the
 * platform stamps and no timestamp of any kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFlowLogs, toFlowEntries, FlowLogCursor } from '../src/core/flowLogs';

const state = (logsByTab: Record<string, unknown[]>, extra: Record<string, unknown> = {}) => ({
  dataFlowEditor: Object.fromEntries(
    Object.entries(logsByTab).map(([tab, logs]) => [tab, { logs, editHistory: [], ...extra }])
  ),
  metadata: { transformDebuggingLogs: [] },
});

const log = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, level: 'debug', nodeId: 'n1', message: 'ran', data: { payload: { x: 1 } }, ...over });

/* ── Extraction ──────────────────────────────────────────────────────────── */

test('extractFlowLogs finds each designer tab that holds a log', () => {
  const groups = extractFlowLogs(state({ tabA: [log('a1')], tabB: [log('b1'), log('b2')] }));
  assert.deepEqual(groups.map((g) => g.tab).sort(), ['tabA', 'tabB']);
  assert.equal(groups.find((g) => g.tab === 'tabB')!.entries.length, 2);
});

test('extractFlowLogs ignores tab state that carries no log', () => {
  const s = { dataFlowEditor: { currentTabId: 'tabA', tabA: { logs: [log('a1')] }, tabB: { editHistory: [] } } };
  const groups = extractFlowLogs(s);
  assert.deepEqual(groups.map((g) => g.tab), ['tabA']);
});

test('extractFlowLogs survives a store without the slice', () => {
  assert.deepEqual(extractFlowLogs({}), []);
  assert.deepEqual(extractFlowLogs(undefined), []);
  assert.deepEqual(extractFlowLogs({ dataFlowEditor: null }), []);
});

test('extractFlowLogs drops entries with no id, since the id is the dedup key', () => {
  const groups = extractFlowLogs(state({ tabA: [log('a1'), { level: 'debug', message: 'no id' }] }));
  assert.deepEqual(groups[0].entries.map((e) => e.id), ['a1']);
});

/* ── Conversion ──────────────────────────────────────────────────────────── */

test('toFlowEntries keeps the platform id, so entries do not renumber as the log grows', () => {
  const [entry] = toFlowEntries([log('cuid-1')], { seqBase: 10, at: 1_700_000_000_000 });
  assert.equal(entry.id, 'cuid-1');
  assert.equal(entry.seq, 10);
  assert.equal(entry.kind, 'flow');
});

test('toFlowEntries carries the whole workflow state as the expandable body', () => {
  const data = { payload: { rows: [1, 2, 3] }, context: { user: 'x' }, claims: {} };
  const [entry] = toFlowEntries([log('a', { data })], { seqBase: 0, at: 1 });
  assert.deepEqual(entry.payload, [data]);
});

test('toFlowEntries leaves duration empty rather than inventing one', () => {
  // The store carries no timing. A fabricated `+Nms` would be indistinguishable
  // from a measured one once it is in the UI.
  const [entry] = toFlowEntries([log('a')], { seqBase: 0, at: 1 });
  assert.equal(entry.dur, '');
});

test('toFlowEntries titles by node name when the caller has the diagram, by id when not', () => {
  const names = new Map([['n1', 'Query Readings']]);
  const [named] = toFlowEntries([log('a')], { seqBase: 0, at: 1, names });
  assert.match(named.title, /Query Readings/);
  assert.equal(named.write, 'flow.Query Readings');

  const [bare] = toFlowEntries([log('b')], { seqBase: 0, at: 1 });
  assert.match(bare.title, /n1/);
});

test('toFlowEntries stamps the designer tab so one tab does not show another one', () => {
  const [entry] = toFlowEntries([log('a')], { seqBase: 0, at: 1, surface: 'tabA' });
  assert.equal(entry.surface, 'tabA');
});

/* ── Cursor ──────────────────────────────────────────────────────────────── */

test('the cursor reports only what is new on each read', () => {
  const cursor = new FlowLogCursor();
  const first = cursor.advance(state({ tabA: [log('a1'), log('a2')] }));
  assert.deepEqual(first[0].entries.map((e) => e.id), ['a1', 'a2']);

  // The store is cumulative: the same two are still there, plus one more.
  const second = cursor.advance(state({ tabA: [log('a1'), log('a2'), log('a3')] }));
  assert.deepEqual(second[0].entries.map((e) => e.id), ['a3']);

  assert.deepEqual(cursor.advance(state({ tabA: [log('a1'), log('a2'), log('a3')] })), []);
});

test('the cursor keeps tabs apart', () => {
  const cursor = new FlowLogCursor();
  cursor.advance(state({ tabA: [log('a1')] }));
  const next = cursor.advance(state({ tabA: [log('a1')], tabB: [log('b1')] }));
  assert.deepEqual(next.map((g) => g.tab), ['tabB']);
});

test('reset makes the cursor report the store again, for a clear or a tab switch', () => {
  const cursor = new FlowLogCursor();
  const s = state({ tabA: [log('a1')] });
  cursor.advance(s);
  assert.deepEqual(cursor.advance(s), []);
  cursor.reset();
  assert.deepEqual(cursor.advance(s)[0].entries.map((e) => e.id), ['a1']);
  assert.equal(cursor.size, 1);
});
