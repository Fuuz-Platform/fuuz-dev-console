/**
 * The rules engine and the report.
 *
 * Every rule here exists because the shape it detects was seen on a real
 * screen — a transform looping, a GraphQL error inside an HTTP 200, the same
 * query fired per row. The tests pin both the detection *and* the restraint:
 * a rule that fires on healthy traffic is worse than no rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, issueTrace, DEFAULTS } from '../src/core/diagnose';
import { normalizeRequest, readGraphql, formatSize, type HarEntry } from '../src/core/network';
import { toMarkdown } from '../src/core/report';
import type { LogEntry, ScreenRunnerPayload } from '../src/core/types';

const T0 = Date.UTC(2026, 7, 16, 13, 0, 0);

const entry = (over: Partial<LogEntry> & { seq: number }): LogEntry => ({
  id: `e${over.seq}`, ts: '13:00:00.000', epoch: T0 + over.seq * 100, kind: 'debug',
  title: 'Transform Debugging · x', dur: '', write: '', reads: [], level: 'debug', payload: [],
  ...over,
});

const har = (over: Partial<HarEntry> & { url: string }): HarEntry => ({
  startedDateTime: new Date(T0).toISOString(),
  time: 40,
  request: { method: 'POST', url: over.url, postData: { text: '{"query":"{ ticket { id } }"}' } },
  response: { status: 200, content: { size: 512, mimeType: 'application/json' } },
  ...over,
});

/* ── Network normalization ───────────────────────────────────────────────── */

test('normalizeRequest: reduces a HAR entry to path, status, timing and size', () => {
  const r = normalizeRequest(har({ url: 'https://api.admin.fuuz.app/application?x=1' }), 1);
  assert.equal(r.id, 'n1');
  assert.equal(r.path, '/application?x=1');
  assert.equal(r.status, 200);
  assert.equal(r.failed, false);
});

test('normalizeRequest: a status of 0 is a transport failure, not a success', () => {
  const r = normalizeRequest(har({ url: 'https://api.admin.fuuz.app/application', response: { status: 0 } }), 1);
  assert.ok(r.failed);
});

test('readGraphql: names the operation, explicitly or from the query', () => {
  assert.equal(readGraphql('{"operationName":"GetTickets","query":"query GetTickets { a }"}', undefined).operation, 'GetTickets');
  assert.equal(readGraphql('{"query":"query Named { a }"}', undefined).operation, 'Named');
  assert.equal(readGraphql('{"query":"{ screenVersion { id } }"}', undefined).operation, 'screenVersion');
  assert.equal(readGraphql('not json', undefined).operation, undefined);
});

test('readGraphql: finds errors carried inside a 200 body', () => {
  const { errors } = readGraphql(undefined, '{"data":null,"errors":[{"message":"Variable $id of type ID! used in position expecting String"}]}');
  assert.equal(errors?.length, 1);
  assert.match(errors![0], /expecting String/);
});

test('formatSize: bytes, KB, MB, and nothing', () => {
  assert.equal(formatSize(0), '—');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
});

/* ── Rules that must fire ────────────────────────────────────────────────── */

test('transform-loop: fires when one path recomputes to the same value in a burst', () => {
  const entries = Array.from({ length: 8 }, (_, i) =>
    entry({ seq: i + 1, write: 'components.Foo.disabled', after: 'true' }));
  const [issue] = diagnose(entries, []).filter((i) => i.rule === 'transform-loop');
  assert.ok(issue, 'loop not detected');
  assert.equal(issue.severity, 'high');
  assert.equal(issue.count, 8);
  assert.equal(issue.path, 'components.Foo.disabled');
  assert.match(issue.detail, /reacting to its own output/);
});

test('transform-loop: a changing value is only medium — it may be real work', () => {
  const entries = Array.from({ length: 8 }, (_, i) =>
    entry({ seq: i + 1, write: 'components.Foo.value', after: `"v${i}"` }));
  const [issue] = diagnose(entries, []).filter((i) => i.rule === 'transform-loop');
  assert.equal(issue.severity, 'medium');
});

test('transform-loop: does NOT fire for the same count spread over a long session', () => {
  // Same eight evaluations, one per minute — that's a person using the screen.
  const entries = Array.from({ length: 8 }, (_, i) =>
    ({ ...entry({ seq: i + 1, write: 'components.Foo.disabled', after: 'true' }), epoch: T0 + i * 60_000 }));
  assert.equal(diagnose(entries, []).filter((i) => i.rule === 'transform-loop').length, 0);
});

test('graphql-error: fires on a 200 that carries errors', () => {
  const request = normalizeRequest(
    har({ url: 'https://api.admin.fuuz.app/application' }), 1,
    '{"errors":[{"message":"Cannot query field \\"nope\\""}]}'
  );
  const [issue] = diagnose([], [request]).filter((i) => i.rule === 'graphql-error');
  assert.ok(issue, 'graphql error missed');
  assert.equal(issue.severity, 'high');
  assert.match(issue.detail, /shows this call as successful/);
});

test('request-failed: groups by status and path', () => {
  const reqs = [1, 2].map((i) => normalizeRequest(
    har({ url: 'https://api.admin.fuuz.app/orchestration/executeFlow', response: { status: 504 } }), i));
  const [issue] = diagnose([], reqs).filter((i) => i.rule === 'request-failed');
  assert.equal(issue.count, 2);
  assert.equal(issue.severity, 'high');
});

test('duplicate-request: fires only for identical bodies in a burst', () => {
  const same = [1, 2, 3, 4].map((i) => normalizeRequest(har({ url: 'https://api.admin.fuuz.app/application' }), i));
  const [dupe] = diagnose([], same).filter((i) => i.rule === 'duplicate-request');
  assert.ok(dupe, 'duplicates missed');
  assert.equal(dupe.count, 4);

  // Different bodies are different calls, however similar the URL.
  const varied = [1, 2, 3, 4].map((i) => normalizeRequest({
    ...har({ url: 'https://api.admin.fuuz.app/application' }),
    request: { method: 'POST', url: 'https://api.admin.fuuz.app/application', postData: { text: `{"id":${i}}` } },
  }, i));
  assert.equal(diagnose([], varied).filter((i) => i.rule === 'duplicate-request').length, 0);
});

test('transform-error and slow-transform fire from the log alone', () => {
  const entries = [
    entry({ seq: 1, kind: 'error', write: 'components.Uploader.url', after: '"btoa failed"', title: 'Transform Error · url' }),
    entry({ seq: 2, write: 'components.Grid.rows', durMs: 1400, dur: '1.4s' }),
  ];
  const rules = diagnose(entries, []).map((i) => i.rule);
  assert.ok(rules.includes('transform-error'));
  assert.ok(rules.includes('slow-transform'));
});

test('a healthy capture produces no issues at all', () => {
  const entries = [entry({ seq: 1, write: 'components.Foo.a', after: '1', durMs: 2 })];
  const ok = normalizeRequest(har({ url: 'https://api.admin.fuuz.app/application' }), 1, '{"data":{"x":1}}');
  assert.deepEqual(diagnose(entries, [ok]), []);
});

test('issues are ranked high → medium → low', () => {
  const entries = [
    entry({ seq: 1, kind: 'error', write: 'a.b', after: '"boom"' }),
    entry({ seq: 2, write: 'c.d', durMs: DEFAULTS.slowTransformMs + 10 }),
  ];
  const severities = diagnose(entries, []).map((i) => i.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) =>
    ({ high: 0, medium: 1, low: 2 }[a] - { high: 0, medium: 1, low: 2 }[b])));
});

/* ── Trace ───────────────────────────────────────────────────────────────── */

test('issueTrace: walks the write chain behind the implicated path', () => {
  const entries = [
    entry({ seq: 1, write: 'components.Table.data', after: '[ 12 items ]' }),
    entry({ seq: 2, write: '(local) $doc', reads: ['components.Table.data'], after: '"…"' }),
    entry({ seq: 3, kind: 'error', write: 'components.Frame.url', reads: ['(local) $doc'], after: '"btoa failed"' }),
  ];
  const [issue] = diagnose(entries, []).filter((i) => i.rule === 'transform-error');
  assert.deepEqual(issueTrace(issue, entries), ['e1', 'e2', 'e3']);
});

/* ── Report ──────────────────────────────────────────────────────────────── */

const payload = (entries: LogEntry[]): ScreenRunnerPayload => ({
  status: 'attached', statusDetail: '', target: { title: 'Asset Intake', url: '' },
  screenName: 'Asset Intake', entries, dropped: 0, snapshotAt: '13:00:01.000',
  tree: [{ id: '__screen__', label: 'Screen', type: 'Asset Intake', vk: 'obj', trace: [], changed: false,
    children: [{ id: 'components', label: 'components', type: '1 key', vk: 'obj', trace: [], changed: true,
      children: [{ id: 'components.Frame.url', label: 'url', type: 'string', value: '"boom"', vk: 'err', trace: ['e1'], changed: true }] }] }],
});

test('toMarkdown: leads with issues, then state, log and network', () => {
  const entries = [entry({ seq: 1, kind: 'error', write: 'components.Frame.url', after: '"btoa failed"', expr: '$base64encode($doc)' })];
  const network = [normalizeRequest(har({ url: 'https://api.admin.fuuz.app/application', response: { status: 504 } }), 1)];
  const md = toMarkdown({ payload: payload(entries), network, issues: diagnose(entries, network), pageUrl: 'https://admin.fuuz.app/x' });

  assert.match(md, /^# Fuuz screen diagnostic — Asset Intake/);
  assert.ok(md.indexOf('## Issues') < md.indexOf('## Screen state'), 'issues must come first');
  assert.match(md, /\[HIGH\]/);
  assert.match(md, /## Execution log/);
  assert.match(md, /## Network/);
  assert.match(md, /## Expressions that failed/);
  assert.match(md, /\$base64encode\(\$doc\)/);
  assert.match(md, /rule: `transform-error`/);
});

test('toMarkdown: says so plainly when nothing matched', () => {
  const md = toMarkdown({ payload: payload([]), network: [], issues: [] });
  assert.match(md, /None detected by the built-in rules/);
  assert.match(md, /not proof the screen is healthy/);
});

test('toMarkdown: redacts session tokens', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhIn0.c2ln';
  const entries = [entry({ seq: 1, kind: 'error', write: 'v.t', after: `"Bearer ${jwt}"` })];
  const md = toMarkdown({ payload: payload(entries), network: [], issues: diagnose(entries, []) });
  assert.ok(!md.includes(jwt), 'a JWT leaked into the report');
  assert.match(md, /\[redacted-jwt\]/);
});

test('toMarkdown: bounds the log so a long run stays pasteable', () => {
  const entries = Array.from({ length: 500 }, (_, i) => entry({ seq: i + 1, write: `v.a${i}`, after: '1' }));
  const md = toMarkdown({ payload: payload(entries), network: [], issues: [] });
  assert.match(md, /last 60 of 500/);
});
