/**
 * Service derivation, and the remote transform evaluator.
 *
 * `/application` is verified against a live tenant; the rest derive from the
 * documented environment-slug rule. The evaluator's job here is to prove it
 * never guesses silently — it reports which request shape a service accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiBase, environmentSlug, evaluateRemote, REMOTE_BODY_SHAPES, services, serviceUrl,
} from '../src/core/services';

test('every service derives from the environment slug', () => {
  const urls = Object.fromEntries(
    services('https://build.mfgx.fuuz.app/app/wms').map((s) => [s.name, s.url])
  );
  assert.equal(urls.application, 'https://api.build.mfgx.fuuz.app/application');
  assert.equal(urls.transformation, 'https://api.build.mfgx.fuuz.app/transformation');
  assert.equal(urls.executeFlow, 'https://api.build.mfgx.fuuz.app/orchestration/executeFlow');
});

test('an api host is not double-prefixed', () => {
  assert.equal(apiBase('https://api.admin.fuuz.app/application'), 'https://api.admin.fuuz.app');
});

test('the slug is the host without api. or .fuuz.app', () => {
  assert.equal(environmentSlug('https://build.mfgx.fuuz.app/x'), 'build.mfgx');
  assert.equal(environmentSlug('https://admin.fuuz.app/x'), 'admin');
});

// This guards where a session token gets sent.
test('a non-Fuuz host yields no services at all', () => {
  assert.deepEqual(services('https://evil.example.com/'), []);
  assert.equal(serviceUrl('https://fuuz.app.evil.com/', 'transformation'), undefined);
});

test('only endpoints actually exercised are marked verified', () => {
  const svc = services('https://admin.fuuz.app/x');
  assert.equal(svc.find((s) => s.name === 'application')?.verified, true);
  assert.equal(svc.find((s) => s.name === 'transformation')?.verified, false);
});

/* ── Remote evaluation ───────────────────────────────────────────────────── */

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('the accepted request shape is reported, not assumed', async () => {
  const tried: string[] = [];
  const out = await evaluateRemote({
    pageUrl: 'https://build.mfgx.fuuz.app/x',
    token: 't', expression: '$.a', context: { a: 1 },
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body);
      tried.push(Object.keys(body).join('+'));
      // Only the third candidate is accepted here.
      if ('expression' in body) return res(200, { result: 1 });
      return res(400, { errors: [{ message: 'bad request' }] });
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.value, 1);
  assert.equal(out.shape, 'expression+context');
  assert.equal(tried.length, 3, 'should stop at the first shape that works');
});

test('a rejected token stops immediately instead of retrying every shape', async () => {
  let calls = 0;
  const out = await evaluateRemote({
    pageUrl: 'https://build.mfgx.fuuz.app/x',
    token: 'expired', expression: '1', context: {},
    fetchFn: async () => { calls += 1; return res(401, { message: 'unauthorized' }); },
  });
  assert.equal(out.ok, false);
  assert.equal(calls, 1, 'a 401 is about the token, not the shape');
  assert.match(out.error ?? '', /expires after about 15 minutes/);
});

test('GraphQL-style errors in a 200 are not read as a value', async () => {
  const out = await evaluateRemote({
    pageUrl: 'https://build.mfgx.fuuz.app/x',
    token: 't', expression: '1', context: {},
    fetchFn: async () => res(200, { errors: [{ message: 'T1006' }] }),
  });
  assert.equal(out.ok, false);
  assert.ok(out.raw, 'the raw body must survive for diagnosis');
});

test('evaluation off-platform is refused rather than attempted', async () => {
  const out = await evaluateRemote({
    pageUrl: 'https://evil.example.com/', token: 't', expression: '1', context: {},
    fetchFn: async () => { throw new Error('must not be called'); },
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /Not a Fuuz page/);
});

test('a network failure is returned, never thrown', async () => {
  const out = await evaluateRemote({
    pageUrl: 'https://build.mfgx.fuuz.app/x', token: 't', expression: '1', context: {},
    fetchFn: async () => { throw new Error('offline'); },
  });
  assert.equal(out.ok, false);
  assert.equal(out.shape, REMOTE_BODY_SHAPES[REMOTE_BODY_SHAPES.length - 1].id);
});
