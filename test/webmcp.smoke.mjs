// Registering the console's diagnostics as WebMCP tools on the page.
//
// Two things under test, and they are different: that the tools are declared
// correctly (names, schemas, annotations), and that a tool call actually reaches
// the panel and comes back. The second is the part that would silently fail.
//
// jsdom has no `document.modelContext`, so this supplies a minimal stand-in that
// records what was registered — which is what a real agent would read.
import { JSDOM } from 'jsdom';
import * as fs from 'fs';

const hook = fs.readFileSync('dist/hook.js', 'utf8');
const relay = fs.readFileSync('dist/relay.js', 'utf8');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};

/** A page with a fake modelContext, on a host we choose. */
function page({ url, isolated = true, withApi = true }) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', url });
  const { window } = dom;
  const registered = [];

  if (isolated) Object.defineProperty(window, 'originAgentCluster', { value: true, configurable: true });
  if (withApi) {
    window.document.modelContext = {
      registerTool: (tool, options) => {
        registered.push({ tool, options });
        options?.signal?.addEventListener('abort', () => {
          const at = registered.findIndex((r) => r.tool.name === tool.name);
          if (at >= 0) registered.splice(at, 1);
        });
        return Promise.resolve();
      },
    };
  }

  const sent = [];
  const handlers = [];
  window.chrome = {
    runtime: {
      // The relay forwards a tool query here; capture it and reply as the worker.
      sendMessage: (msg, cb) => { sent.push(msg); cb?.({ ok: true, echoed: msg.query }); },
      onMessage: { addListener: (f) => handlers.push(f) },
      lastError: undefined,
    },
  };
  for (const src of [hook, relay]) {
    const tag = window.document.createElement('script');
    tag.textContent = src;
    window.document.body.appendChild(tag);
  }
  const ask = (msg) => new Promise((resolve) => {
    let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    handlers.find((h) => h.length >= 3)(msg, {}, settle);
    setTimeout(() => settle({ timedOut: true }), 2000);
  });
  return { window, registered, sent, ask };
}

/* ── Availability reporting ──────────────────────────────────────────────── */

console.log('availability is reported, never assumed');

const noApi = page({ url: 'https://admin.fuuz.app/x', isolated: false, withApi: false });
const off = await noApi.ask({ type: 'webmcpRegister' });
check('an un-isolated page says so, and names the fix', !off.available && /origin-isolated/i.test(off.reason ?? ''),
  JSON.stringify(off));
check('and reports origin isolation separately from API presence', off.originIsolated === false,
  JSON.stringify(off));

const isolatedNoApi = page({ url: 'https://admin.fuuz.app/x', isolated: true, withApi: false });
const flagless = await isolatedNoApi.ask({ type: 'webmcpRegister' });
check('isolated but no API points at the flag, not the header',
  /origin trial|enable-webmcp-testing/i.test(flagless.reason ?? ''), flagless.reason);

// Host permissions already restrict us, but the code checks too — a permission
// widening must not silently widen where tools get registered.
const offPlatform = page({ url: 'https://evil.example.com/x' });
const refused = await offPlatform.ask({ type: 'webmcpRegister' });
check('tools are never registered off a Fuuz host',
  !refused.available && offPlatform.registered.length === 0, JSON.stringify(refused));

/* ── Registration ────────────────────────────────────────────────────────── */

console.log('\nwhat gets registered');

const p = page({ url: 'https://admin.fuuz.app/system/configuration/applicationDesigner' });
const status = await p.ask({ type: 'webmcpRegister' });
check('registration succeeds on an isolated Fuuz page', status.available && !status.reason,
  JSON.stringify(status));
check('six read-only tools are registered', p.registered.length === 6,
  p.registered.map((r) => r.tool.name).join(', '));

// The whole point of the POC boundary: nothing here can change the page.
check('every tool declares readOnlyHint',
  p.registered.length === 6 && p.registered.every((r) => r.tool.annotations?.readOnlyHint === true),
  JSON.stringify(p.registered.map((r) => [r.tool.name, r.tool.annotations])));
check('no mutating capability is exposed as a page tool',
  p.registered.length === 6 && !p.registered.some((r) => /callFn|setValue|applyStyle|screenshot|capture/i.test(r.tool.name)),
  p.registered.map((r) => r.tool.name).join(', '));

// Console output and screen state are whatever the app put there.
const stateTool = p.registered.find((r) => r.tool.name === 'fuuz_screen_state');
check('content the page authored is marked untrusted',
  stateTool?.tool.annotations?.untrustedContentHint === true,
  JSON.stringify(stateTool?.tool.annotations));
const statusTool = p.registered.find((r) => r.tool.name === 'fuuz_screen_status');
check('but our own status is not marked untrusted',
  statusTool?.tool.annotations?.untrustedContentHint === false,
  JSON.stringify(statusTool?.tool.annotations));

check('every tool has a description and a JSON Schema',
  p.registered.length === 6 && p.registered.every((r) =>
    typeof r.tool.description === 'string' && r.tool.description.length > 20
    && r.tool.inputSchema?.type === 'object'), 'a tool is missing one');
const evalTool = p.registered.find((r) => r.tool.name === 'fuuz_screen_eval');
check('fuuz_screen_eval requires an expression',
  evalTool?.tool.inputSchema?.required?.includes('expression'),
  JSON.stringify(evalTool?.tool.inputSchema));

/* ── A tool call reaches the panel ───────────────────────────────────────── */

console.log('\na tool call round-trips to the panel');

const elements = p.registered.find((r) => r.tool.name === 'fuuz_screen_elements');
const out = await elements.tool.execute({ name: 'AssetIntakeForm' });
check('execute returns a string, as the API requires', typeof out === 'string', typeof out);
check('the query reached the relay and was forwarded',
  p.sent.some((m) => m.type === 'webmcpQuery' && m.query === 'elements'),
  JSON.stringify(p.sent));
check('the arguments travel with it',
  p.sent.some((m) => m.args?.name === 'AssetIntakeForm'), JSON.stringify(p.sent));
check('the answer comes back through', /"echoed": *"elements"/.test(out), out.slice(0, 120));

/* ── Re-registration and teardown ────────────────────────────────────────── */

console.log('\nlifecycle');

await p.ask({ type: 'webmcpRegister' });
check('re-registering replaces rather than duplicates', p.registered.length === 6,
  `${p.registered.length} tools after a second register`);

await p.ask({ type: 'webmcpUnregister' });
check('unregistering removes every tool', p.registered.length === 0,
  p.registered.map((r) => r.tool.name).join(', '));

/* ── The header rule ─────────────────────────────────────────────────────── */

console.log('\nthe origin-isolation rule');

// Node 25 strips types, so the module imports directly; fall back to the bundle
// if that ever stops being true. Either way this must assert, not skip.
let rule = null;
try { ({ ORIGIN_ISOLATION_RULE: rule } = await import('../src/extension/originIsolation.ts')); }
catch { /* fall through to the bundle */ }

if (rule) {
  const hdr = rule.action.responseHeaders[0];
  check('the rule sets Origin-Agent-Cluster', hdr.header === 'Origin-Agent-Cluster', JSON.stringify(hdr));
  // `append` would make it a list, which is not a valid structured boolean.
  check('with set, not append', hdr.operation === 'set', hdr.operation);
  check('to a structured boolean true', hdr.value === '?1', hdr.value);
  check('scoped to fuuz.app only', JSON.stringify(rule.condition.requestDomains) === '["fuuz.app"]',
    JSON.stringify(rule.condition.requestDomains));
  // Isolating subframes could cut the app off from frames it expects to reach.
  check('top-level documents only', JSON.stringify(rule.condition.resourceTypes) === '["main_frame"]',
    JSON.stringify(rule.condition.resourceTypes));
  check('a fixed id, so enabling twice replaces rather than stacks',
    typeof rule.id === 'number', String(rule.id));
} else {
  const bg = fs.readFileSync('dist/background.js', 'utf8');
  check('the rule sets Origin-Agent-Cluster', bg.includes('Origin-Agent-Cluster'));
  check('scoped to fuuz.app', bg.includes('fuuz.app'));
  check('documents only', bg.includes('main_frame'));
  check('a structured boolean value', bg.includes('?1'));
}

// The two gates fail for different reasons and have different fixes, so the
// message must name whichever is actually blocking.
console.log('\nthe reason names the blocking gate, not the symptom');
check('un-isolated points at the header and the new tab',
  /new tab/i.test(off.reason ?? '') && !/chrome:\/\/flags/.test(off.reason ?? ''), off.reason);
check('isolated-but-no-API points at the flag, not the header',
  /chrome:\/\/flags/.test(flagless.reason ?? '') && !/new tab/i.test(flagless.reason ?? ''),
  flagless.reason);
check('and mentions the trial token as the rollout path',
  /origin trial|trial/i.test(flagless.reason ?? ''), flagless.reason);

if (rule) {
  const { trialRule } = await import('../src/extension/originIsolation.ts');
  const t = trialRule('TOKEN123');
  const h = t.action.responseHeaders[0];
  check('the trial rule sets Origin-Trial', h.header === 'Origin-Trial', JSON.stringify(h));
  // An origin may already run other trials; `set` would switch them off.
  check('by appending, not replacing', h.operation === 'append', h.operation);
  check('carrying the token', h.value === 'TOKEN123', h.value);
  check('and uses its own rule id', t.id !== rule.id, `${t.id} vs ${rule.id}`);
}

console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
