/**
 * A minimal Chrome DevTools Protocol client — just enough to subscribe to a
 * page's console and read its arguments back as plain JSON.
 *
 * We attach over CDP rather than scraping the debug console because the screen
 * runtime logs *objects*: a text pipe would flatten `{ expression, result,
 * trace }` into "…{…}" and there would be nothing left to classify. CDP hands
 * back RemoteObjects that we serialize by value.
 *
 * Dependency-free by design. The WebSocket comes from the host (Node ≥ 22 has
 * one globally); `ws` is used only if the host predates that.
 */
import * as http from 'http';

/** The subset of the WebSocket surface both implementations share. */
interface Socket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}
type SocketCtor = new (url: string) => Socket;

/** A debuggable page, as reported by `/json/list`. */
export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class CdpError extends Error {}

/** Resolve a WebSocket implementation, preferring the host's own. */
function socketCtor(): SocketCtor {
  const globalWs = (globalThis as unknown as { WebSocket?: SocketCtor }).WebSocket;
  if (typeof globalWs === 'function') return globalWs;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('ws') as SocketCtor;
  } catch {
    throw new CdpError(
      'No WebSocket implementation available. Update to a VS Code build on Node 22+, ' +
      'or install `ws` in the extension.'
    );
  }
}

/** GET a JSON endpoint on the DevTools HTTP port. */
function getJson<T>(port: number, path: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
        catch (err) { reject(new CdpError(`Malformed DevTools response from :${port} — ${String(err)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new CdpError(`DevTools port ${port} timed out.`)); });
    req.on('error', (err) => reject(new CdpError(`DevTools port ${port} unreachable — ${err.message}`)));
  });
}

/** Every debuggable page on the port. Rejects if nothing is listening. */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  const all = await getJson<CdpTarget[]>(port, '/json/list');
  return all.filter((t) => t.type === 'page' && !!t.webSocketDebuggerUrl);
}

/** Whether a browser is listening on the DevTools port at all. */
export async function isPortLive(port: number): Promise<boolean> {
  try { await getJson<unknown>(port, '/json/version', 800); return true; }
  catch { return false; }
}

type EventHandler = (params: Record<string, unknown>) => void;

/** One attached page. Commands are promise-based; events go to `on` handlers. */
export class CdpSession {
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private closed = false;

  private constructor(readonly target: CdpTarget) {}

  static async attach(target: CdpTarget): Promise<CdpSession> {
    if (!target.webSocketDebuggerUrl) throw new CdpError(`Target ${target.id} exposes no debugger URL.`);
    const session = new CdpSession(target);
    const Ctor = socketCtor();
    const socket = new Ctor(target.webSocketDebuggerUrl);
    session.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('Timed out attaching to the page.')), 10_000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new CdpError('Failed to open the DevTools socket.')); };
    });

    socket.onmessage = (ev) => session.dispatch(String(ev.data));
    socket.onclose = () => { session.closed = true; session.emit('__closed', {}); };
    socket.onerror = null;
    return session;
  }

  private dispatch(raw: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
    try { msg = JSON.parse(raw); } catch { return; }

    if (typeof msg.id === 'number') {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new CdpError(msg.error.message));
      else slot.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit(msg.method, msg.params ?? {});
  }

  private emit(method: string, params: Record<string, unknown>): void {
    for (const fn of this.handlers.get(method) ?? []) {
      try { fn(params); } catch { /* a bad handler must not kill the stream */ }
    }
  }

  on(method: string, fn: EventHandler): void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(fn);
    this.handlers.set(method, set);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed || !this.socket) return Promise.reject(new CdpError('The DevTools session is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try { this.socket!.send(JSON.stringify({ id, method, params })); }
      catch (err) { this.pending.delete(id); reject(new CdpError(String(err))); }
    });
  }

  dispose(): void {
    this.closed = true;
    this.pending.forEach((p) => p.reject(new CdpError('Session disposed.')));
    this.pending.clear();
    this.handlers.clear();
    try { this.socket?.close(); } catch { /* already gone */ }
    this.socket = null;
  }

  get isClosed(): boolean { return this.closed; }
}

/** A CDP `Runtime.RemoteObject`, narrowed to the fields we read. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

/**
 * Serialize one console argument to plain JSON.
 *
 * Primitives come back inline. Objects are round-tripped through
 * `callFunctionOn(returnByValue)` so we get the whole structure, not CDP's
 * 5-property preview — the screen runtime nests its trace metadata deeper than
 * a preview reaches. Anything that won't serialize (cyclic, DOM node, huge)
 * degrades to its description rather than failing the entry.
 */
export async function resolveArg(session: CdpSession, arg: RemoteObject, maxBytes = 96_000): Promise<unknown> {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.type === 'function') return `ƒ ${arg.description?.split('\n')[0] ?? 'anonymous'}`;
  if (!arg.objectId) return arg.value;
  if (arg.subtype === 'node') return arg.description ?? '[node]';

  try {
    const res = await session.send<{ result?: RemoteObject; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
      objectId: arg.objectId,
      // Structured-clone via JSON so getters, Errors and Maps flatten predictably.
      functionDeclaration: `function () {
        const seen = new WeakSet();
        const walk = (v, depth) => {
          if (v === null || typeof v !== 'object') return typeof v === 'function' ? 'ƒ ' + (v.name || 'anonymous') : v;
          if (seen.has(v)) return '[Circular]';
          if (depth > 8) return '[…]';
          seen.add(v);
          if (v instanceof Error) return { name: v.name, message: v.message, stack: (v.stack || '').split('\\n').slice(0, 4).join('\\n'),
            ...Object.fromEntries(Object.getOwnPropertyNames(v).filter(k => !['stack'].includes(k)).map(k => [k, v[k]])) };
          if (Array.isArray(v)) return v.slice(0, 200).map(x => walk(x, depth + 1));
          const out = {};
          for (const k of Object.keys(v).slice(0, 200)) { try { out[k] = walk(v[k], depth + 1); } catch (e) { out[k] = '[unreadable]'; } }
          return out;
        };
        return walk(this, 0);
      }`,
      returnByValue: true,
      awaitPromise: false,
    });
    const value = res.result?.value;
    if (value === undefined) return arg.description ?? null;
    // Guard the payload we forward to the webview — one runaway object shouldn't
    // stall the panel.
    const encoded = JSON.stringify(value);
    if (encoded && encoded.length > maxBytes) {
      return { '[truncated]': `${Math.round(encoded.length / 1024)} KB`, preview: encoded.slice(0, 2000) + '…' };
    }
    return value;
  } catch {
    return arg.description ?? '[unserializable]';
  } finally {
    void session.send('Runtime.releaseObject', { objectId: arg.objectId }).catch(() => undefined);
  }
}
