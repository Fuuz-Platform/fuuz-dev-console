import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, extractReads, formatDuration, formatValue, mergeRules, normalizePath, DEFAULT_RULES } from '../src/core/classify';
import { provenanceFor, writeSatisfiesRead } from '../src/core/provenance';
import { buildStateTree, findNode } from '../src/core/stateTree';
import { chromeArgs, findChrome } from '../src/node/chrome';
import { pickTarget, sameRoute, screenNameFrom } from '../src/node/session';
import type { LogEntry, RawConsoleEvent } from '../src/core/types';

/* ── Path normalization ──────────────────────────────────────────────────── */

test('normalizePath: strips the JSONata sigil off rooted paths', () => {
  assert.equal(normalizePath('$components.IntakePrepare.url'), 'components.IntakePrepare.url');
  assert.equal(normalizePath('$context.metadata.user.id'), 'context.metadata.user.id');
  assert.equal(normalizePath('variables.uploadState'), 'variables.uploadState');
});

test('normalizePath: namespaces transform-locals so they cannot collide with state', () => {
  assert.equal(normalizePath('$doc'), '(local) $doc');
  assert.equal(normalizePath('$mine'), '(local) $mine');
});

test('normalizePath: applies writeRoot only to unrooted paths', () => {
  assert.equal(normalizePath('uploadState', 'variables'), 'variables.uploadState');
  assert.equal(normalizePath('components.Foo.data', 'variables'), 'components.Foo.data');
});

/* ── Read extraction ─────────────────────────────────────────────────────── */

test('extractReads: finds state reads and ignores builtin calls', () => {
  const expr = '$rows[requestedByUserId = $me and state = "issued" and expire > $now]';
  assert.deepEqual(extractReads(expr), ['(local) $rows']);
});

test('extractReads: picks up rooted component and context reads', () => {
  const expr = '$components.TicketTable.data[0].id = $context.metadata.user.id';
  assert.deepEqual(extractReads(expr), ['components.TicketTable.data', 'context.metadata.user.id']);
});

test('extractReads: a token followed by ( is a call, not a read', () => {
  assert.deepEqual(extractReads('$base64encode($doc)'), ['(local) $doc']);
  assert.deepEqual(extractReads('$exists($components.Form.data)'), ['components.Form.data']);
});

/* ── Classification ──────────────────────────────────────────────────────── */

const ev = (seq: number, args: unknown[], level = 'log'): RawConsoleEvent =>
  ({ seq, level, timestamp: Date.UTC(2026, 7, 16, 10, 24, 31, 802) + seq, args });

/*
 * These assert against `fixtures/transformDebug.json` — a real capture from the
 * platform's own screen runner (Fuuz Administration, Asset Intake, 2026-08-16),
 * not an assumed shape.
 */
// tsc doesn't copy .json into outDir, so fall back to the source tree when the
// fixture isn't sitting next to the compiled test.
const FIXTURE = [
  join(__dirname, 'fixtures', 'transformDebug.json'),
  join(__dirname, '..', '..', 'test', 'fixtures', 'transformDebug.json'),
].find(existsSync);

const CAPTURE = JSON.parse(readFileSync(FIXTURE!, 'utf8')) as { level: string; args: unknown[] }[];

const fromCapture = (i: number, seq = i + 1): LogEntry =>
  classify({ seq, level: CAPTURE[i].level, timestamp: Date.UTC(2026, 7, 16, 10, 24, 31), args: CAPTURE[i].args });

test('capture fixture: the runtime logs console.debug("Transform Debugging: ", {…})', () => {
  assert.equal(CAPTURE.length, 2);
  assert.equal(CAPTURE[0].level, 'debug');
  assert.equal(CAPTURE[0].args[0], 'Transform Debugging: ');
  assert.deepEqual(
    Object.keys(CAPTURE[0].args[1] as object),
    ['expression', 'context', 'payload', 'trace', 'remote', 'language', 'result']
  );
});

test('classify: an action-owned transform attributes the write to its component', () => {
  const entry = fromCapture(0);
  assert.equal(entry.kind, 'debug');
  // trace.origin === 'Action' and trace.actionName === 'IntakePrepare'.
  assert.equal(entry.write, 'components.IntakePrepare.disabled');
  assert.equal(entry.dur, '1ms');
  assert.equal(entry.after, 'true');
  assert.equal(entry.title, 'Transform Debugging · disabled');
});

test('classify: reads come out of the real JSONata, including $metadata', () => {
  const entry = fromCapture(1);
  assert.ok(entry.reads.includes('metadata.user.id'), `got ${JSON.stringify(entry.reads)}`);
  assert.ok(entry.reads.includes('components.TicketTable.data'), `got ${JSON.stringify(entry.reads)}`);
});

test('classify: a transform with no action owner is bucketed, never mis-attributed', () => {
  const entry = fromCapture(1);
  // trace carries `property: "url"` but no actionName — the runtime does not say
  // which component owns it, so we must not invent one.
  assert.equal(entry.write, '(computed).url');
});

test('classify: every entry carries the runtime context snapshot', () => {
  const ctx = fromCapture(0).context as Record<string, unknown>;
  assert.deepEqual(Object.keys(ctx), ['metadata', 'components', 'showScreenDialog']);
  assert.ok(Object.keys(ctx.components as object).includes('AssetIntakeForm'));
});

test('classify: a transform error is kind error and carries the platform error text', () => {
  const entry = classify(ev(8, ['Transform Error: ', {
    expression: '$executeFlow(flowId, payload)',
    trace: { runtime: 4, property: 'uploadState', origin: 'Action', actionName: 'IntakePrepare' },
    error: { name: 'HttpError', jse_shortmsg: 'Gateway Timeout', code: 504 },
  }], 'error'));
  assert.equal(entry.kind, 'error');
  assert.equal(entry.write, 'components.IntakePrepare.uploadState');
  assert.equal(entry.after, '"Gateway Timeout"');
});

test('classify: a query entry takes its duration from `took`', () => {
  const entry = classify(ev(2, ['Query', { operationName: 'ticket.findMany', target: 'components.TicketTable.data', took: 118, rows: 12 }]));
  assert.equal(entry.kind, 'query');
  assert.equal(entry.dur, '118ms');
  assert.equal(entry.write, 'components.TicketTable.data');
});

test('classify: an unrecognised call is still an entry, just without state', () => {
  const entry = classify(ev(1, ['something the platform did', { a: 1 }]));
  assert.equal(entry.kind, 'log');
  assert.equal(entry.write, '');
  assert.equal(entry.title, 'something the platform did');
  // The payload survives, so the raw call is still readable in the console.
  assert.deepEqual(entry.payload[1], { a: 1 });
});

test('classify: console.error with no matching rule is still an error', () => {
  assert.equal(classify(ev(1, ['boom'], 'error')).kind, 'error');
});

test('classify: a malformed user regex skips its rule instead of breaking capture', () => {
  const rules = [{ id: 'bad', kind: 'error' as const, match: '([unclosed', title: 'nope' }, ...DEFAULT_RULES];
  const entry = classify(ev(1, ['Query', { operationName: 'x' }]), rules);
  assert.equal(entry.kind, 'query');
});

test('mergeRules: same id replaces in place, new id is tried first', () => {
  const merged = mergeRules([
    { id: 'query', kind: 'log', match: '^Q', title: 'overridden' },
    { id: 'tenant-thing', kind: 'flow', match: '^Tenant', title: 'Tenant' },
  ]);
  assert.equal(merged[0].id, 'tenant-thing');
  assert.equal(merged.find(r => r.id === 'query')?.title, 'overridden');
  assert.equal(merged.length, DEFAULT_RULES.length + 1);
});

/* ── Provenance ──────────────────────────────────────────────────────────── */

const entry = (seq: number, write: string, reads: string[], after = 'x'): LogEntry => ({
  id: `e${seq}`, seq, ts: '10:24:31.000', epoch: seq, kind: 'debug', title: `t${seq}`,
  dur: '', write, reads, after, level: 'log', payload: [],
});

// The chain from the design: the url is produced by a base64 doc, built from a
// filtered row set, built from the signed-in user and the ticket query.
const CHAIN: LogEntry[] = [
  entry(1, 'context.metadata.user', [], '{ id: "cmsucf7v" }'),
  entry(2, 'components.TicketTable.data', [], '[ 12 items ]'),
  entry(3, '(local) $mine', ['context.metadata.user.id', 'components.TicketTable.data'], '1 match'),
  entry(4, '(local) $doc', ['(local) $mine'], '4211'),
  entry(5, 'components.IntakePrepare.url', ['(local) $doc'], '"data:text/html;base64,…"'),
];

test('writeSatisfiesRead: matches exactly, and by ancestry in both directions', () => {
  assert.ok(writeSatisfiesRead('components.Form.data', 'components.Form.data'));
  assert.ok(writeSatisfiesRead('components.Form.data', 'components.Form.data.assetCollection'));
  assert.ok(writeSatisfiesRead('components.Form.data.assetCollection', 'components.Form.data'));
  assert.ok(!writeSatisfiesRead('components.Form.dataset', 'components.Form.data'));
  assert.ok(!writeSatisfiesRead('', 'components.Form.data'));
});

test('provenanceFor: walks the read/write graph back to the roots, oldest first', () => {
  assert.deepEqual(provenanceFor(CHAIN, 'components.IntakePrepare.url'), ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('provenanceFor: a value with no dependencies traces only to its own write', () => {
  assert.deepEqual(provenanceFor(CHAIN, 'components.TicketTable.data'), ['e2']);
});

test('provenanceFor: only writes that happened BEFORE the reader count', () => {
  const later = [...CHAIN, entry(6, 'context.metadata.user', [], '{ id: "other" }')];
  // e5's chain still resolves the user through e1 — e6 came after it ran.
  assert.deepEqual(provenanceFor(later, 'components.IntakePrepare.url'), ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('provenanceFor: a mutual read/write cycle terminates', () => {
  const cyclic = [
    entry(1, 'variables.a', ['variables.b']),
    entry(2, 'variables.b', ['variables.a']),
    entry(3, 'variables.a', ['variables.b']),
  ];
  assert.deepEqual(provenanceFor(cyclic, 'variables.a'), ['e1', 'e2', 'e3']);
});

test('provenanceFor: an unwritten path has no trace', () => {
  assert.deepEqual(provenanceFor(CHAIN, 'components.Nothing.here'), []);
});

/* ── State tree ──────────────────────────────────────────────────────────── */

test('buildStateTree: groups writes under a screen root by their path segments', () => {
  const tree = buildStateTree(CHAIN, 'AssetIntake');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].type, 'AssetIntake');

  const url = findNode(tree, 'components.IntakePrepare.url');
  assert.ok(url, 'leaf missing');
  assert.equal(url!.value, '"data:text/html;base64,…"');
  assert.equal(url!.vk, 'str');
  assert.ok(url!.changed);
  // The tree carries the provenance, which is what the ⌁ badge counts.
  assert.deepEqual(url!.trace, ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('buildStateTree: reads real state out of the logged context snapshot', () => {
  const tree = buildStateTree([fromCapture(0), fromCapture(1)], 'Asset Intake');

  // Components the transforms never touched still appear — the snapshot has them.
  const title = findNode(tree, 'components.AssetIntakeForm.data.title');
  assert.ok(title, 'form data missing from the snapshot');
  assert.equal(title!.value, '"Screen Runner capture"');

  const view = findNode(tree, 'components.TicketTable.currentView.name');
  assert.equal(view?.value, '"Default"');

  // Functions are labelled, not rendered as empty objects.
  assert.equal(findNode(tree, 'components.AssetIntakeForm.fn.save')?.vk, 'fn');
});

test('buildStateTree: computed props are layered on — the snapshot never carries them', () => {
  const tree = buildStateTree([fromCapture(0), fromCapture(1)], 'Asset Intake');
  // context.components.IntakePrepare is only `{ fn: { execute } }`; `disabled`
  // exists solely because a transform produced it.
  assert.equal(findNode(tree, 'components.IntakePrepare.disabled')?.value, 'true');
  assert.ok(findNode(tree, 'components.IntakePrepare.fn.execute'), 'snapshot child lost');
  // …and the unattributed one is visibly bucketed.
  assert.ok(findNode(tree, '(computed).url'), 'unattributed prop missing');
});

test('buildStateTree: a written path marks its ancestors as changed', () => {
  const tree = buildStateTree([fromCapture(0)], 'Asset Intake');
  assert.ok(findNode(tree, 'components.IntakePrepare')?.changed, 'parent not marked');
  assert.ok(findNode(tree, 'components')?.changed, 'root not marked');
  // Untouched siblings stay unmarked, so the amber dot means something.
  assert.equal(findNode(tree, 'components.TicketTable')?.changed, false);
});

test('buildStateTree: the newest write wins — the tree is a snapshot, not a history', () => {
  const tree = buildStateTree([
    entry(1, 'variables.uploadState', [], '"idle"'),
    entry(2, 'variables.uploadState', [], '"error: Gateway Timeout"'),
  ]);
  assert.equal(findNode(tree, 'variables.uploadState')!.value, '"error: Gateway Timeout"');
});

test('buildStateTree: an error write colours the node as an error', () => {
  const failing: LogEntry = { ...entry(1, 'variables.uploadState', [], '"Gateway Timeout"'), kind: 'error' };
  assert.equal(findNode(buildStateTree([failing]), 'variables.uploadState')!.vk, 'err');
});

test('buildStateTree: entries that write nothing produce no tree at all', () => {
  assert.deepEqual(buildStateTree([entry(1, '', [])]), []);
});

test('buildStateTree: roots keep runtime order, not insertion order', () => {
  // The runtime nests context as { metadata, components, … }; `(computed)` is
  // our own bucket and sorts last so it never displaces real state.
  const tree = buildStateTree([
    entry(1, 'variables.a', []), entry(2, '(computed).b', []),
    entry(3, 'components.C.d', []), entry(4, 'metadata.user.id', []),
  ]);
  assert.deepEqual(tree[0].children!.map(c => c.label), ['metadata', 'components', 'variables', '(computed)']);
});

/* ── Formatting ──────────────────────────────────────────────────────────── */

test('formatDuration: ms under a second, seconds above', () => {
  assert.equal(formatDuration(34), '34ms');
  assert.equal(formatDuration(30000), '30.0s');
  assert.equal(formatDuration(undefined), '');
});

test('formatValue: collections summarise, long strings truncate', () => {
  assert.equal(formatValue([1, 2, 3]), '[ 3 items ]');
  assert.equal(formatValue([1]), '[ 1 item ]');
  assert.equal(formatValue({ a: 1, b: 2, c: 3 }), '{ a: 1, b: 2, … }');
  assert.ok(formatValue('x'.repeat(300)).length <= 96);
});

/* ── Target selection + launch flags ─────────────────────────────────────── */

const targets = [
  { id: '1', type: 'page', title: 'Fuuz', url: 'https://build.mfgx.fuuz.app/app/wms/Dashboard', webSocketDebuggerUrl: 'ws://a' },
  { id: '2', type: 'page', title: 'Asset Intake', url: 'https://build.mfgx.fuuz.app/app/wms/AssetIntake', webSocketDebuggerUrl: 'ws://b' },
];

test('pickTarget: matches on URL, then title, and falls back to the first page', () => {
  assert.equal(pickTarget(targets, 'AssetIntake')?.id, '2');
  assert.equal(pickTarget(targets, 'Asset Intake')?.id, '2');
  assert.equal(pickTarget(targets, targets[0].url)?.id, '1');
  assert.equal(pickTarget(targets, '')?.id, '1');
  assert.equal(pickTarget(targets, 'nothing-like-this'), undefined);
});

test('pickTarget: an unparseable filter degrades to substring matching', () => {
  assert.equal(pickTarget(targets, 'Asset[Intake')?.id, undefined);
  assert.equal(pickTarget(targets, '([')?.id, undefined);
});

test('sameRoute: ignores query and hash, so a rewritten query is not a redirect', () => {
  const run = 'https://admin.fuuz.app/system/configuration/screens/abc/run?Asset%20Intake.TicketTable.view=Default';
  // The platform rewrites the query on load — that must not read as a redirect,
  // or the session would re-navigate forever.
  assert.ok(sameRoute(run, 'https://admin.fuuz.app/system/configuration/screens/abc/run'));
  assert.ok(sameRoute(run, run + '#x'));
  assert.ok(sameRoute('https://a.fuuz.app/x/', 'https://a.fuuz.app/x'));
  // The real redirect this guards against: /run → the deployed app route.
  assert.ok(!sameRoute(run, 'https://admin.fuuz.app/customerRelationshipManagement/sales/assetIntake'));
  assert.ok(!sameRoute(run, 'https://other.fuuz.app/system/configuration/screens/abc/run'));
});

test('sameRoute: unparseable input falls back to string equality', () => {
  assert.ok(sameRoute('not a url', 'not a url'));
  assert.ok(!sameRoute('not a url', 'also not'));
});

test('screenNameFrom: prefers the last path segment, falls back to the title', () => {
  assert.equal(screenNameFrom('https://build.mfgx.fuuz.app/app/wms/AssetIntake'), 'AssetIntake');
  assert.equal(screenNameFrom('not a url', 'Tab title'), 'Tab title');
  assert.equal(screenNameFrom(''), 'Screen');
});

test('chromeArgs: opens the debug port with a persistent profile', () => {
  const args = chromeArgs({ executable: '/x', port: 9222, userDataDir: '/tmp/p', url: 'https://a.fuuz.app' });
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--user-data-dir=/tmp/p'));
  // Chrome 136+ silently refuses the port without this.
  assert.ok(args.includes('--remote-allow-origins=*'));
  assert.equal(args[args.length - 1], 'https://a.fuuz.app');
});

test('findChrome: returns the first candidate that exists, or undefined', () => {
  assert.match(findChrome('darwin', (p) => String(p).includes('Google Chrome.app'))!, /Google Chrome$/);
  assert.equal(findChrome('darwin', () => false), undefined);
  assert.equal(findChrome('sunos', () => true), undefined);
});
