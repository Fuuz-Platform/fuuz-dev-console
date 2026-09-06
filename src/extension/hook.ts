/**
 * MAIN-world console hook.
 *
 * This is the whole reason a browser extension beats the DevTools-protocol
 * approach: the Fuuz screen runtime announces every transform through
 * `console.debug`, so capturing it needs nothing more than wrapping `console`
 * in the page's own world. No debug port, no second browser, no re-login.
 *
 * Runs in the MAIN world (see `manifest.json`) because an isolated content
 * script has its own `console` and would never see the page's calls. It talks
 * to the isolated-world relay over `window.postMessage`, which is the only
 * channel the two worlds share.
 */

import { huntDesign } from './designHunt';
import { registerWebMcpTools, unregisterWebMcpTools, webMcpStatus } from './webmcp';
import { pageQuery } from './pageServices';
import { flowLinks, engineApi, flowEvents, flowNodeDetail, flowNodeNames, flowRunPayloads, runSummary, setFlowNodeValue } from './flowEvents';
import { flowLogs, resetFlowLogs } from './storeTap';
import { callFn, probeFiber } from './fiber';

const CHANNEL = 'fuuz-dev-console';

/**
 * Requests the isolated world cannot serve itself.
 *
 * Chrome gives an isolated content script its own JS heap: DOM nodes are shared,
 * but expando properties the page put on them are not. So `__reactFiber$…` and
 * every page global — `window.__APOLLO_CLIENT__` included — are invisible to the
 * relay, and anything that reads them has to be answered from here.
 *
 * This was a real bug, not a precaution: the fiber probe and `fn` calls were
 * implemented in the relay and could never have worked in a browser. jsdom has
 * no world isolation, so the tests passed anyway.
 */
const REQ = 'fuuz-devtool-request';
const RES = 'fuuz-devtool-response';

/**
 * Accept only same-page messages.
 *
 * `e.source === window` is the browser's own signal for a same-window post. The
 * origin check is what actually keeps a cross-origin iframe out — it cannot
 * forge `location.origin` — and it is strictly tighter than the source check
 * alone. The `null`/`''` pair is jsdom's shape for a same-window post, which
 * cannot occur on a real https page, and is what makes this path testable at all.
 */
function fromThisPage(e: MessageEvent): boolean {
  const sourceOk = e.source === window || e.source === null;
  const originOk = e.origin === '' || e.origin === location.origin;
  return sourceOk && originOk;
}

function installMainWorldResponder(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (!fromThisPage(e)) return;
    const msg = e.data as { source?: string; id?: number; type?: string; payload?: Record<string, unknown> } | null;
    if (!msg || msg.source !== REQ || typeof msg.id !== 'number') return;

    const reply = (result: unknown) =>
      window.postMessage({ source: RES, id: msg.id, result: safe(result) }, '*');

    try {
      const p = (msg.payload ?? {}) as {
        target?: Parameters<typeof probeFiber>[0] extends Element | null ? never : never;
        selector?: string;
        fn?: string;
        args?: unknown[];
        includeGraph?: boolean;
      };
      switch (msg.type) {
        case 'probeElement':
          // The relay resolves the element to a selector, because it owns the
          // locator; this world only has to find the fiber behind it.
          reply(probeFiber(p.selector ? document.querySelector(p.selector) : null));
          return;
        case 'callElementFn':
          reply(callFn(
            p.selector ? document.querySelector(p.selector) : null,
            String(p.fn ?? ''),
            Array.isArray(p.args) ? p.args : []
          ));
          return;
        case 'huntDesign':
          reply(huntDesign(p.includeGraph === true));
          return;
        case 'flowEvents': {
          // Subscribing is idempotent, so polling this is safe — it attaches on
          // the first call and only reports thereafter.
          const state = flowEvents();
          reply({ ...state, summary: runSummary(state.runs) });
          return;
        }
        case 'engineApi':
          reply(engineApi());
          return;
        case 'flowLogs': {
          // The designer's own log, read from `dataFlowEditor[tab].logs` rather than
          // scraped from the drawer it renders. Polled: the cursor reports only what
          // is new, so calling it on the flow-events cadence costs a state read.
          const q = p as { seqBase?: number; names?: Record<string, string> };
          // Names default to the engine's own, so the caller does not have to know
          // that the store carries node ids and nothing else.
          reply(flowLogs(Number(q.seqBase ?? 0), q.names ?? flowNodeNames()));
          return;
        }
        case 'resetFlowLogs':
          resetFlowLogs();
          reply({ ok: true });
          return;
        case 'pageQuery': {
          // The services, reached the way a screen reaches them — see `pageServices.ts`.
          const q = p as { service?: string; query?: string; variables?: Record<string, unknown> };
          void pageQuery(String(q.service ?? 'application'), String(q.query ?? ''), q.variables ?? {})
            .then(reply);
          return;
        }
        case 'flowLinks':
          // The link model, so wire highlighting is a lookup rather than a measurement.
          reply(flowLinks());
          return;
        case 'flowRunPayloads':
          reply(flowRunPayloads(String((p as { node?: string }).node ?? '')));
          return;
        case 'flowNodeDetail':
          reply(flowNodeDetail(String((p as { id?: string }).id ?? '')));
          return;
        case 'setFlowNodeValue': {
          const q = p as { id?: string; path?: string; value?: unknown };
          reply(setFlowNodeValue(String(q.id ?? ''), String(q.path ?? ''), q.value));
          return;
        }
        case 'webmcpStatus':
          reply(webMcpStatus());
          return;
        case 'webmcpRegister':
          void registerWebMcpTools().then(reply);
          return;
        case 'webmcpUnregister':
          unregisterWebMcpTools();
          reply({ ok: true });
          return;
        default:
          reply({ error: `Unknown main-world request: ${msg.type}` });
      }
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
const LEVELS = ['log', 'debug', 'info', 'warn', 'error'] as const;

/** Structured-clone can't carry functions or cycles — flatten to plain JSON. */
function safe(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? `ƒ ${(value as { name?: string }).name || 'anonymous'}` : value;
  }
  if (seen.has(value as object)) return '[Circular]';
  if (depth > 8) return '[…]';
  seen.add(value as object);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: (value.stack || '').split('\n').slice(0, 4).join('\n'),
      ...Object.fromEntries(
        Object.getOwnPropertyNames(value)
          .filter((k) => k !== 'stack')
          .map((k) => [k, (value as unknown as Record<string, unknown>)[k]])
      ),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => safe(v, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).slice(0, 200)) {
    try { out[key] = safe((value as Record<string, unknown>)[key], depth + 1, seen); }
    catch { out[key] = '[unreadable]'; }
  }
  return out;
}

declare global {
  interface Window { __fuuzScreenRunnerHooked?: boolean }
}

/**
 * Turn on the platform's own transform logging.
 *
 * `transformDebuggingEnabled` is a session-scoped user setting — the app reads
 * it once at store init:
 *
 *   transformDebuggingEnabled: "true" === sessionStorage.getItem("transformDebuggingEnabled")
 *
 * and gates every `Transform Debugging:` emission on it. It is normally toggled
 * from the avatar menu, or with `?developerMode=true`.
 *
 * This content script runs at `document_start`, i.e. before the app bundle
 * evaluates, so setting the flag here means the runtime comes up with logging
 * already on — on any route, with no user action. Without it the panel is
 * silent and it looks like the tool is broken.
 */
function enablePlatformDebugging(): void {
  try {
    if (sessionStorage.getItem('transformDebuggingEnabled') !== 'true') {
      sessionStorage.setItem('transformDebuggingEnabled', 'true');
    }
  } catch {
    /* storage can be blocked; the panel's health check will report the silence */
  }
}

function install(): void {
  if (window.__fuuzScreenRunnerHooked) return;
  window.__fuuzScreenRunnerHooked = true;
  enablePlatformDebugging();

  let seq = 0;
  for (const level of LEVELS) {
    // The page's own bundle loads *after* this content script and installs its
    // own console handlers (the platform ships a Console pane, so it does
    // exactly that). A plain reassignment would silently replace our wrapper
    // and we'd capture nothing.
    //
    // So install an accessor instead: reads always get our wrapper, and a later
    // `console.debug = fn` is captured as the new downstream target rather than
    // overwriting us. Order of loading stops mattering.
    let downstream: (...args: unknown[]) => void = console[level].bind(console);

    const wrapper = (...args: unknown[]) => {
      try {
        window.postMessage({
          source: CHANNEL,
          event: { seq: ++seq, level, timestamp: Date.now(), args: args.map((a) => safe(a)) },
        }, '*');
      } catch {
        /* never let capture break the page's own logging */
      }
      try { downstream(...args); } catch { /* the page's handler is its problem */ }
    };

    try {
      Object.defineProperty(console, level, {
        configurable: true,
        enumerable: true,
        get: () => wrapper,
        set: (fn: (...args: unknown[]) => void) => { downstream = typeof fn === 'function' ? fn : downstream; },
      });
    } catch {
      // Some environments refuse to redefine console; fall back to assignment.
      console[level] = wrapper as typeof console.log;
    }
  }

  // Uncaught errors never reach `console.error`, but they are exactly what you
  // want to see next to a failed transform.
  window.addEventListener('error', (e) => {
    window.postMessage({
      source: CHANNEL,
      event: {
        seq: ++seq, level: 'error', timestamp: Date.now(),
        args: [e.message, safe(e.error)],
        origin: e.filename ? `${e.filename}:${e.lineno}` : undefined,
      },
    }, '*');
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.postMessage({
      source: CHANNEL,
      event: { seq: ++seq, level: 'error', timestamp: Date.now(), args: ['Unhandled rejection', safe(e.reason)] },
    }, '*');
  });
}

install();
installMainWorldResponder();
export {};
