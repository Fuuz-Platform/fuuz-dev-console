/**
 * The JavaScript runner, in a sandboxed frame.
 *
 * An extension page's CSP is `script-src 'self'` — no `eval`, no `new Function`. That
 * is a good default and not one worth weakening for the whole panel, so the script
 * runs here instead: a page declared under `sandbox.pages`, which Chrome loads into
 * an opaque origin with **no extension APIs at all**. No `chrome.*`, no access to the
 * Fuuz tab, no storage, no network identity. It can compute and it can answer, and
 * that is the entire surface.
 *
 * That containment is the reason this is not a gated capability. Nothing here can
 * reach the page under test, so running a script in it is not a mutation of anything
 * — unlike `evaluateRemote`, which executes against a live tenant.
 *
 * ## What cannot be fixed from inside
 *
 * `while (true) {}` wedges this frame. A sandboxed frame has no worker to terminate
 * and no way to interrupt its own synchronous execution, so the *panel* times out and
 * replaces the iframe. Stated plainly in the UI rather than pretending there is a
 * timeout here.
 */
import { toTransferable, wrapScript } from '../core/scriptRun';

interface RunRequest {
  source: 'fuuz-script-sandbox';
  id: number;
  script: string;
  payload: unknown;
  context: Record<string, unknown>;
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as RunRequest | null;
  if (!msg || msg.source !== 'fuuz-script-sandbox' || typeof msg.id !== 'number') return;

  const logs: string[] = [];
  /*
   * `console.log` is captured rather than left to the devtools console.
   *
   * A sandboxed frame's console output lands in a place the developer is not looking
   * — they are looking at the panel. Logging is how anyone debugs a script, so the
   * output has to come back with the result.
   */
  const native = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' '));
    native.apply(console, args as []);
  };

  const started = performance.now();
  let reply: Record<string, unknown>;
  try {
    // Indirect, and with the inputs passed as named parameters rather than
    // interpolated: a payload containing a quote would otherwise break the source,
    // and a payload is data, never code.
    const run = new Function('__payload', '__context', wrapScript(msg.script, Object.keys(msg.context)));
    const value = run(msg.payload, msg.context);
    if (value && typeof (value as Promise<unknown>).then === 'function') {
      (value as Promise<unknown>).then(
        (resolved) => post({ id: msg.id, ok: true, value: toTransferable(resolved), logs, elapsedMs: performance.now() - started }),
        (e) => post({ id: msg.id, ok: false, error: describe(e), logs, elapsedMs: performance.now() - started })
      );
      console.log = native;
      return;
    }
    reply = { id: msg.id, ok: true, value: toTransferable(value), logs, elapsedMs: performance.now() - started };
  } catch (e) {
    reply = { id: msg.id, ok: false, error: describe(e), logs, elapsedMs: performance.now() - started };
  }
  console.log = native;
  post(reply);
});

/**
 * An error, with the line it came from where that is knowable.
 *
 * A bare "Unexpected token" in a thirty-line script is not enough to act on, and the
 * wrapper shifts the line numbers, so the raw stack would mislead — the first stack
 * frame is reported as-is and labelled as being from the wrapped source.
 */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const frame = (e.stack ?? '').split('\n')[1]?.trim();
  return frame ? `${e.name}: ${e.message}\n  at ${frame} (line numbers include the wrapper)` : `${e.name}: ${e.message}`;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(toTransferable(value)); } catch { return String(value); }
}

function post(reply: Record<string, unknown>): void {
  // `*` because a sandboxed frame has an opaque origin: it cannot name its parent,
  // and its parent is the panel that created it.
  parent.postMessage({ source: 'fuuz-script-sandbox-result', ...reply }, '*');
}

// The panel waits for this before sending, so a script is never dropped because the
// frame had not finished loading.
parent.postMessage({ source: 'fuuz-script-sandbox-ready' }, '*');
