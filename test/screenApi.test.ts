/**
 * Fetching the deployed design.
 *
 * The response shapes here are the ones the live API actually returned
 * (Fuuz Administration Build, 2026-08-16) — including the `String!` variable
 * type, which rejects the more obvious `ID!`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiBaseFor, fetchScreenDesign, redactTokens, screenVersionIdFrom, SCREEN_VERSION_QUERY,
} from '../src/core/screenApi';

/* ── Host derivation ─────────────────────────────────────────────────────── */

test('apiBaseFor: the API host is the app host with an api. prefix', () => {
  assert.equal(apiBaseFor('https://admin.fuuz.app/x/y'), 'https://api.admin.fuuz.app');
  assert.equal(apiBaseFor('https://build.mfgx.fuuz.app/app/wms'), 'https://api.build.mfgx.fuuz.app');
});

test('apiBaseFor: already-api hosts are not double-prefixed', () => {
  assert.equal(apiBaseFor('https://api.admin.fuuz.app/application'), 'https://api.admin.fuuz.app');
});

test('apiBaseFor: refuses anything that is not a fuuz.app host', () => {
  assert.equal(apiBaseFor('https://evil.example.com/'), undefined);
  assert.equal(apiBaseFor('not a url'), undefined);
  // A lookalike domain must not resolve — this guards where the token is sent.
  assert.equal(apiBaseFor('https://fuuz.app.evil.com/'), undefined);
});

/* ── Screen version resolution ───────────────────────────────────────────── */

test('screenVersionIdFrom: prefers the runtime context over the URL', () => {
  const context = { metadata: { urlParameters: { screenVersionId: 'cmsvvlf7u0jal016k5ztgfqs4' } } };
  assert.equal(
    screenVersionIdFrom(context, 'https://admin.fuuz.app/system/configuration/screens/OTHER/run'),
    'cmsvvlf7u0jal016k5ztgfqs4'
  );
});

test('screenVersionIdFrom: falls back to the URL before any context arrives', () => {
  // Real ids are 25-char cuids. The length guard is what stops route words like
  // /screens/new or /screens/list being mistaken for one.
  const id = 'cmsw337o80jo2016k6vvgcag3';
  const cases = [
    `https://admin.fuuz.app/system/configuration/screens/${id}/run?x=1`,   // deployed
    `https://admin.fuuz.app/system/configuration/screens/${id}`,            // no /run
    `https://admin.fuuz.app/system/configuration/applicationDesigner?screenVersionId=${id}`,
    `https://admin.fuuz.app/x?screenId=${id}`,
  ];
  for (const url of cases) assert.equal(screenVersionIdFrom(undefined, url), id, url);
});

test('screenVersionIdFrom: does not mistake a route word for an id', () => {
  assert.equal(screenVersionIdFrom(undefined, 'https://admin.fuuz.app/system/configuration/screens/new'), undefined);
  assert.equal(screenVersionIdFrom(undefined, 'https://admin.fuuz.app/system/configuration/screens/list/run'), undefined);
});

test('screenVersionIdFrom: undefined when neither source has it', () => {
  assert.equal(screenVersionIdFrom({}, 'https://admin.fuuz.app/home'), undefined);
});

/* ── Fetch ───────────────────────────────────────────────────────────────── */

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const LIVE = {
  data: {
    screenVersion: {
      edges: [{
        node: {
          id: 'cmsvvlf7u0jal016k5ztgfqs4',
          number: '0.0.15',
          deployed: true,
          screen: { name: 'Asset Intake' },
          design: { components: [{ name: 'Asset Intake', type: 'canvas', props: { design: {} } }] },
        },
      }],
    },
  },
};

test('fetchScreenDesign: returns a document shaped for indexScreenDesign', async () => {
  let sent: { url: string; body: string; auth?: string } | undefined;
  const doc = await fetchScreenDesign({
    apiBase: 'https://api.admin.fuuz.app',
    token: 'tok-123',
    screenVersionId: 'cmsvvlf7u0jal016k5ztgfqs4',
    fetchFn: async (url, init) => {
      sent = { url, body: init.body, auth: init.headers.Authorization };
      return okResponse(LIVE);
    },
  });

  assert.equal(sent!.url, 'https://api.admin.fuuz.app/application');
  assert.equal(sent!.auth, 'Bearer tok-123');
  assert.match(sent!.body, /screenVersion/);
  assert.deepEqual(doc, {
    name: 'Asset Intake', version: '0.0.15', deployed: true,
    design: LIVE.data.screenVersion.edges[0].node.design,
  });
});

test('the query declares $id as String — the schema rejects ID!', () => {
  assert.match(SCREEN_VERSION_QUERY, /\$id:String!/);
  assert.doesNotMatch(SCREEN_VERSION_QUERY, /\$id:ID!/);
});

test('fetchScreenDesign: degrades to undefined rather than throwing', async () => {
  const cases: { label: string; fetchFn: Parameters<typeof fetchScreenDesign>[0]['fetchFn'] }[] = [
    { label: 'http error', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) },
    { label: 'graphql errors', fetchFn: async () => okResponse({ errors: [{ message: 'nope' }] }) },
    { label: 'no such version', fetchFn: async () => okResponse({ data: { screenVersion: { edges: [] } } }) },
    { label: 'null design', fetchFn: async () => okResponse({ data: { screenVersion: { edges: [{ node: { design: null } }] } } }) },
    { label: 'network throw', fetchFn: async () => { throw new Error('offline'); } },
  ];
  for (const c of cases) {
    const doc = await fetchScreenDesign({
      apiBase: 'https://api.admin.fuuz.app', token: 't', screenVersionId: 'x', fetchFn: c.fetchFn,
    });
    assert.equal(doc, undefined, `${c.label} should yield undefined`);
  }
});

/* ── Redaction ───────────────────────────────────────────────────────────── */

test('redactTokens: blanks JWTs anywhere in a captured payload', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhYmMifQ.c2lnbmF0dXJl';
  const out = redactTokens({
    args: [`Authorization: Bearer ${jwt}`, { nested: { token: jwt }, list: [jwt] }],
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes(jwt), 'a JWT survived redaction');
  assert.equal(text.match(/\[redacted-jwt\]/g)?.length, 3);
});

test('redactTokens: leaves ordinary values alone', () => {
  const input = { a: 1, b: 'plain text', c: [true, null] };
  assert.deepEqual(redactTokens(input), input);
});
