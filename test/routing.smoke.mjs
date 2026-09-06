// Do the panel's requests actually reach the page?
//
// Written after a real bug: `probeDesigner` asked the page with
// `chrome.runtime.sendMessage`, which reaches extension contexts only and never
// a content script. The worker had no handler for it, so the reply was always
// undefined — Design and Structure stayed permanently empty in the App Designer,
// while every other suite passed. The relay tests call the relay *directly*, so
// none of them could see a break in the wiring between panel and page.
//
// This suite exercises the service worker's routing table instead: for each
// message the panel sends, does the worker forward it to the tab, and does the
// answer come back on the port?
import { JSDOM } from 'jsdom';
import * as fs from 'fs';

const worker = fs.readFileSync('dist/background.js', 'utf8');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};

/*
 * A minimal service-worker environment: enough `chrome.*` for the worker to
 * register its listeners, plus a fake tab that records what it is sent.
 */
function bootWorker({ tabUrl = 'https://build.mfgx.fuuz.app/app/x' } = {}) {
  const dom = new JSDOM('<!doctype html>', { runScripts: 'dangerously', url: 'https://example.invalid/' });
  const { window } = dom;

  const sentToTab = [];
  const posted = [];
  let connectHandler;

  window.chrome = {
    runtime: {
      onConnect: { addListener: (f) => { connectHandler = f; } },
      onMessage: { addListener: () => {} },
      lastError: undefined,
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    tabs: {
      sendMessage: (tabId, msg, cb) => {
        sentToTab.push({ tabId, msg });
        // Echo a recognisable reply so we can prove it came back.
        cb?.({ ok: true, echoed: msg.type, designer: 'screen', tabId: 'cmsvt7hww002k3b6xvit7djw0' });
      },
      get: async () => ({ id: 1, url: tabUrl, active: true, windowId: 9 }),
      query: async () => [],
      reload: async () => {},
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    },
    windows: { onRemoved: { addListener: () => {} }, create: async () => ({ id: 1 }), update: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: () => {}, set: () => {} } },
  };

  const s = window.document.createElement('script');
  s.textContent = worker;
  window.document.body.appendChild(s);

  if (!connectHandler) throw new Error('the worker never registered onConnect');

  const port = {
    name: 'fuuz-dev-console-panel',
    postMessage: (m) => posted.push(m),
    onMessage: { addListener: (f) => { port._recv = f; } },
    onDisconnect: { addListener: () => {} },
  };
  connectHandler(port);
  port._recv({ type: 'init', tabId: 1 });
  return { port, sentToTab, posted };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

console.log('panel → worker → page routing');

const { port, sentToTab, posted } = bootWorker();

// Everything the panel asks the *page* for. A message missing from the worker's
// forwarding list is silently dropped, which is exactly how the bug survived.
const PAGE_REQUESTS = [
  ['getDesignerSurface', 'designerSurface'],
  ['probeElement', 'elementProbe'],
  ['getElementStyles', 'elementStyles'],
  ['getSessionToken', 'sessionToken'],
  ['callElementFn', 'fnResult'],
  ['highlight', 'highlightResult'],
];

for (const [type, replyType] of PAGE_REQUESTS) {
  sentToTab.length = 0;
  posted.length = 0;
  port._recv({ type, target: { name: 'X' }, fn: 'setValue', args: [] });
  await settle();
  check(`${type} reaches the page`,
    sentToTab.some((s) => s.msg.type === type),
    `worker forwarded: ${sentToTab.map((s) => s.msg.type).join(', ') || '(nothing)'}`);
  check(`${type} answers on the port as ${replyType}`,
    posted.some((p) => p.type === replyType),
    `posted: ${posted.map((p) => p.type).join(', ') || '(nothing)'}`);
}

// The specific regression: the designer reply must carry the tab id, because in
// the App Designer that is the only handle on which screen is open.
sentToTab.length = 0; posted.length = 0;
port._recv({ type: 'getDesignerSurface' });
await settle();
const designerReply = posted.find((p) => p.type === 'designerSurface');
check('the designer reply carries the open tab id',
  !!designerReply?.tabId, JSON.stringify(designerReply));
check('and which surface it is', designerReply?.designer === 'screen', JSON.stringify(designerReply));

/* ── The gate still applies to the routed messages ───────────────────────── */

console.log('\ngate, enforced in the worker');

const prod = bootWorker({ tabUrl: 'https://mfgx.fuuz.app/app/wms' });
prod.sentToTab.length = 0; prod.posted.length = 0;
prod.port._recv({ type: 'callElementFn', target: { name: 'X' }, fn: 'setValue', args: [] });
await settle();
check('a mutating call never reaches a production page',
  !prod.sentToTab.some((s) => s.msg.type === 'callElementFn'),
  JSON.stringify(prod.sentToTab));
check('and the panel is told why',
  /production|disabled/i.test(prod.posted.find((p) => p.type === 'fnResult')?.error ?? ''),
  JSON.stringify(prod.posted));

prod.sentToTab.length = 0; prod.posted.length = 0;
prod.port._recv({ type: 'getDesignerSurface' });
await settle();
check('but a read-only request still reaches production',
  prod.sentToTab.some((s) => s.msg.type === 'getDesignerSurface'),
  JSON.stringify(prod.sentToTab));

console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
