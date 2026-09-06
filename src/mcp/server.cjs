#!/usr/bin/env node
/**
 * Fuuz Dev Console — MCP server.
 *
 * Chrome's own devtools MCP can hand an agent raw console lines and raw
 * requests. That is not what is expensive: re-deriving *meaning* from them is.
 * This exposes the analysis instead — classified entries, the screen's state
 * tree, the provenance chain behind any value, the design join, the diagnosed
 * issues, and a JSONata evaluator bound to the live context.
 *
 * So an agent asks "what's wrong with this screen" and gets an answer, rather
 * than 4,000 log lines to reason about.
 *
 * Transport is stdio JSON-RPC — the MCP baseline — hand-rolled to keep this
 * dependency-free beyond what the tool already needs.
 *
 *   claude mcp add fuuz-ui --  node <repo>/platform/dev-console/src/mcp/server.cjs
 */
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', '..', 'out', 'src');
if (!fs.existsSync(path.join(OUT, 'node', 'session.js'))) {
  process.stderr.write('Build first:  npm run compile:node\n');
  process.exit(1);
}
const { ScreenRunnerSession } = require(path.join(OUT, 'node', 'session.js'));
const { mergeRules } = require(path.join(OUT, 'core', 'classify.js'));
const { indexScreenDesign } = require(path.join(OUT, 'core', 'designJoin.js'));
const { lintDesign } = require(path.join(OUT, 'core', 'designLint.js'));
const { diagnose, issueTrace } = require(path.join(OUT, 'core', 'diagnose.js'));
const { toMarkdown } = require(path.join(OUT, 'core', 'report.js'));
const { findNode } = require(path.join(OUT, 'core', 'stateTree.js'));

/* ── Capture state ───────────────────────────────────────────────────────── */

let session = null;          // CDP capture, when the agent drives its own Chrome
let latest = null;
let design = null;
let designFindings = [];
let bridged = null;          // snapshot pushed by the browser extension
let bridgedAt = 0;

/**
 * Prefer whatever the extension is pushing.
 *
 * The extension watches the developer's own signed-in browser, so its capture is
 * the real session — richer than anything this process can drive, and it needs
 * no second Chrome and no second login.
 */
const snapshot = () => bridged?.payload ?? (latest ??= session?.snapshot() ?? null);
const entries = () => snapshot()?.entries ?? [];
const liveContext = () => [...entries()].reverse().find((e) => e.context)?.context;

/** The extension sees network; the CDP console path does not. */
const network = () => bridged?.network ?? [];

function requireCapture() {
  if (!bridged && !session) {
    // Name the real cause. A stale server holding the port is a different
    // problem from a closed panel, and saying "no capture" for both is what made
    // this hard to diagnose.
    if (bindState.status === 'taken') throw new Error(bindState.detail);
    throw new Error(
      'No capture. Either open the Fuuz Dev Console in Chrome and press "Connect to Claude", ' +
      'or call fuuz_screen_attach to drive a browser from here.'
    );
  }
}

/* ── Bridge: the extension pushes what it captures ───────────────────────── */

const BRIDGE_PORT = Number(process.env.FUUZ_BRIDGE_PORT || 8788);

/**
 * Whether this process actually owns the bridge port.
 *
 * Reported by `fuuz_screen_status`, because "nothing captured" and "another
 * process owns the port" look identical from a tool call and have completely
 * different fixes.
 */
let bindState = { status: 'starting', detail: undefined };

/** A parked screenshot request, and whoever is waiting for the image. */
let captureRequest = null;
let captureWaiters = [];

/**
 * Ask the panel for a screenshot and wait for it.
 *
 * Resolves to a stated failure rather than hanging: the panel may be closed,
 * the tab may be in the background, or the environment may refuse capture
 * altogether — and a tool call that never returns explains none of that.
 */
function requestCapture(target, maxEdge, timeoutMs = 15000) {
  captureRequest = { target: target || null, maxEdge: maxEdge || 1200, at: Date.now() };
  return new Promise((resolve) => {
    const done = (v) => {
      const at = captureWaiters.indexOf(done);
      if (at >= 0) captureWaiters.splice(at, 1);
      resolve(v);
    };
    captureWaiters.push(done);
    setTimeout(() => {
      captureRequest = null;
      done({
        ok: false,
        error:
          'No screenshot arrived. The panel must be open with "Connect to Claude" enabled, and the ' +
          'Fuuz tab must be the active tab in its window.',
      });
    }, timeoutMs);
  });
}

function startBridge() {
  const http = require('http');
  const server = http.createServer((req, res) => {
    // The panel is an extension page, so this is cross-origin and — from
    // Chrome's perspective — a request into the private network.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true, server: 'fuuz-dev-console',
        connected: !!bridged, lastPushAt: bridgedAt || null,
        bridge: bindState.status, bridgeDetail: bindState.detail || null,
        // The panel can't know where this repo lives; this process does, so it
        // hands back the real command rather than a <repo> placeholder.
        serverPath: __filename,
        setupCommand: `claude mcp add fuuz-ui --scope user -- node ${__filename}`,
        // Claude Desktop takes a JSON block rather than a CLI command.
        desktopConfig: JSON.stringify(
          { mcpServers: { 'fuuz-ui': { command: 'node', args: [__filename] } } },
          null, 2
        ),
      }));
    }

    /**
     * Read the current capture.
     *
     * The bridge is otherwise write-only, which makes the pushed state
     * unreachable to anything but the MCP tools. A read endpoint lets any local
     * tool — a script, a session without the tools loaded — see what the panel
     * is holding.
     */
    if (req.url === '/snapshot' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(bridged ?? { empty: true }));
    }

    /**
     * Screenshot request channel.
     *
     * The bridge is otherwise one-way — the panel pushes, tools read — but a
     * screenshot has to be *asked for*: it is a moment in time, not state, and
     * pushing one with every snapshot would cost megabytes per second for an
     * image nobody requested.
     *
     * So a tool call parks a request here, the panel long-polls `GET /capture`
     * and answers with `POST /capture`. One shallow queue, because a second
     * pending request would only ever produce a near-identical image.
     */
    if (req.url === '/capture' && req.method === 'GET') {
      // Long-poll: hold the connection until the panel asks, or time out. A
      // fast 204 loop would spin the panel's network stack for nothing.
      if (captureRequest) {
        const pending = captureRequest;
        captureRequest = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(pending));
      }
      res.writeHead(204); return res.end();
    }

    if (req.url === '/capture' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 40e6) req.destroy(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const waiting = captureWaiters;
          captureWaiters = [];
          waiting.forEach((fn) => fn(parsed));
          res.writeHead(204); res.end();
        } catch {
          res.writeHead(400); res.end('bad json');
        }
      });
      return;
    }

    if (req.url === '/snapshot' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 40e6) req.destroy(); });
      req.on('end', () => {
        try {
          bridged = JSON.parse(body);
          bridgedAt = Date.now();
          res.writeHead(204); res.end();
        } catch {
          res.writeHead(400); res.end('bad json');
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  /**
   * Keep trying to bind, and never pretend we did.
   *
   * Losing the port used to be silent: the server kept running, `bridged` stayed
   * null, and every tool reported "No capture" — indistinguishable from the panel
   * being closed. That cost real debugging time more than once.
   *
   * So the bind state is recorded and surfaced through `fuuz_screen_status`, and
   * the listen is retried: when whatever holds the port goes away, this instance
   * takes over instead of staying dead for the life of the session.
   */
  const retry = () => setTimeout(() => server.listen(BRIDGE_PORT, '127.0.0.1'), 2000);
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      if (bindState.status !== 'taken') {
        bindState = {
          status: 'taken',
          detail:
            `Another process already holds 127.0.0.1:${BRIDGE_PORT}. This server's tools cannot ` +
            'see the extension\'s captures until it is freed — usually a leftover MCP server from ' +
            'a previous session. Retrying every 2s.',
        };
        process.stderr.write(`bridge: port ${BRIDGE_PORT} in use; retrying\n`);
      }
      return retry();
    }
    bindState = { status: 'error', detail: err ? err.message : 'unknown' };
    process.stderr.write(`bridge: ${err && err.message}\n`);
  });
  server.on('listening', () => {
    bindState = { status: 'listening' };
    process.stderr.write(`bridge listening on http://127.0.0.1:${BRIDGE_PORT}\n`);
  });
  server.listen(BRIDGE_PORT, '127.0.0.1');
}
startBridge();

/* ── Tools ───────────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'fuuz_screen_attach',
    description:
      'Attach to a Fuuz screen and start capturing. Launches Chrome with a persistent profile if nothing is listening on the DevTools port; you may need to sign in once in that window. Any screen URL works — the runtime reports its own version, so the designer preview and the deployed route are both fine.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The screen URL to open.' },
        urlFilter: { type: 'string', description: 'Tab URL/title to attach to. Defaults to the url.' },
        port: { type: 'number', description: 'DevTools port (default 9222).' },
        designFile: { type: 'string', description: 'Optional screen design JSON to join against.' },
      },
      required: ['url'],
    },
    async run(args) {
      session?.dispose();
      latest = null; design = null; designFindings = [];
      if (args.designFile) {
        const doc = JSON.parse(fs.readFileSync(args.designFile, 'utf8'));
        design = indexScreenDesign(doc, doc.name);
        designFindings = lintDesign(design, doc);
      }
      session = new ScreenRunnerSession({
        port: args.port ?? 9222,
        urlFilter: args.urlFilter || args.url,
        targetUrl: args.url,
        userDataDir: path.join(require('os').homedir(), '.fuuz', 'dev-console-profile'),
        rules: mergeRules([]),
        maxEntries: 5000,
        autoLaunch: true,
        design: design ?? undefined,
      }, (payload) => { latest = payload; });
      await session.start();
      const s = snapshot();
      return {
        status: s?.status, detail: s?.statusDetail, screen: s?.screenName,
        note: 'Capture is live. Interact with the screen, then call fuuz_screen_issues or fuuz_screen_report.',
      };
    },
  },
  {
    name: 'fuuz_screen_status',
    description:
      'Where the data is coming from, and whether anything is connected. Call this first if a tool says there is no capture.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      const s = snapshot();
      return {
        source: bridged ? 'browser extension (bridge)' : session ? 'CDP session' : 'none',
        bridgePort: BRIDGE_PORT,
        lastPushSecondsAgo: bridgedAt ? Math.round((Date.now() - bridgedAt) / 1000) : null,
        screen: s?.screenName ?? null,
        entries: s?.entries?.length ?? 0,
        requests: network().length,
        design: s?.design ? `${s.design.screenName} v${s.design.version ?? '?'}` : null,
        // "Nothing captured" and "another process owns the port" look identical
        // from a tool call and have completely different fixes, so say which.
        bridge: bindState.status,
        bridgeDetail: bindState.detail,
        hint: bridged || session
          ? undefined
          : bindState.status === 'taken'
            ? bindState.detail
            : 'In Chrome, open the Fuuz Dev Console and press "Connect to Claude".',
      };
    },
  },
  {
    name: 'fuuz_screen_issues',
    description:
      'The diagnosed problems with the captured run, ranked — transform errors and loops, slow transforms, and (when a design is loaded) static design defects such as $base64encode over characters btoa cannot encode. Each carries the write chain that evidences it.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      requireCapture();
      const found = diagnose(entries(), network());
      return {
        runtime: found.map((i) => ({
          severity: i.severity, rule: i.rule, title: i.title, detail: i.detail,
          count: i.count, path: i.path,
          trace: issueTrace(i, entries()).slice(0, 10).map((id) => {
            const e = entries().find((x) => x.id === id);
            return e && { ts: e.ts, title: e.title, writes: e.write, value: e.after, expr: e.expr };
          }).filter(Boolean),
        })),
        design: (bridged?.designFindings ?? designFindings).map((i) => ({ severity: i.severity, rule: i.rule, title: i.title, detail: i.detail })),
        note: found.length || designFindings.length ? undefined
          : 'No rule matched. That is not proof the screen is healthy.',
      };
    },
  },
  {
    name: 'fuuz_screen_state',
    description:
      "The screen's current state, read from the context snapshot the runtime logs. Pass a dot path to get one subtree. Values marked changed were written during this run; `trace` counts the writes behind them.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Dot path, e.g. components.TicketTable.data' },
        depth: { type: 'number', description: 'Max depth to return (default 4).' },
      },
    },
    run(args) {
      requireCapture();
      const tree = snapshot()?.tree ?? [];
      const root = args.path ? [findNode(tree, args.path)].filter(Boolean) : tree;
      if (args.path && !root.length) return { error: `No state at "${args.path}".` };
      const prune = (nodes, d) => nodes.map((n) => ({
        path: n.id, type: n.type, value: n.value, changed: n.changed,
        writesBehind: n.trace.length || undefined,
        children: n.children && d > 0 ? prune(n.children, d - 1) : undefined,
      }));
      return { state: prune(root, args.depth ?? 4) };
    },
  },
  {
    name: 'fuuz_screen_trace',
    description:
      'How a value came to be: the ordered chain of writes that produced the value at a state path, walked backwards through each expression\'s reads. This is the question a log cannot answer.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Dot path, e.g. components.TusUploader.url' } },
      required: ['path'],
    },
    run(args) {
      requireCapture();
      const node = findNode(snapshot()?.tree ?? [], args.path);
      if (!node) return { error: `No state at "${args.path}".` };
      return {
        path: args.path, value: node.value,
        chain: node.trace.map((id, i) => {
          const e = entries().find((x) => x.id === id);
          return e && { step: i + 1, ts: e.ts, title: e.title, dur: e.dur, writes: e.write, value: e.after, expr: e.expr };
        }).filter(Boolean),
      };
    },
  },
  {
    name: 'fuuz_screen_log',
    description: 'The classified execution log. Filter by substring across the title, write target and expression.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string' },
        kind: { type: 'string', description: 'query | debug | flow | error | log' },
        limit: { type: 'number', description: 'Default 50, newest last.' },
      },
    },
    run(args) {
      requireCapture();
      let list = entries();
      if (args.kind) list = list.filter((e) => e.kind === args.kind);
      if (args.filter) {
        const q = args.filter.toLowerCase();
        list = list.filter((e) => `${e.title} ${e.write} ${e.expr ?? ''}`.toLowerCase().includes(q));
      }
      return {
        total: entries().length, shown: Math.min(list.length, args.limit ?? 50),
        entries: list.slice(-(args.limit ?? 50)).map((e) => ({
          ts: e.ts, kind: e.kind, title: e.title, dur: e.dur,
          writes: e.write || undefined, value: e.after, element: e.elementType,
        })),
      };
    },
  },
  {
    name: 'fuuz_screen_eval',
    description:
      "Evaluate a JSONata expression against the screen's live context, with $metadata / $components bound exactly as the runtime binds them. Use this to check a transform before putting it in the designer — the bundled JSONata is 2.1.1, the platform's own version.",
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    async run(args) {
      requireCapture();
      const context = liveContext();
      if (!context) return { error: 'No context captured yet — interact with the screen first.' };
      const jsonata = require('jsonata');
      try {
        const value = await jsonata(args.expression).evaluate(context, context);
        return { result: value === undefined ? null : value, matched: value !== undefined };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'fuuz_screen_report',
    description:
      'The whole run as a markdown diagnostic — issues first with their traces, then state, log and the expressions that failed. Bounded and token-aware; session tokens are redacted.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      requireCapture();
      const s = snapshot();
      const found = diagnose(entries(), network());
      return {
        markdown: toMarkdown({
          payload: s, network: network(),
          issues: [...found, ...designFindings], pageUrl: s?.target?.url,
        }),
      };
    },
  },
  {
    name: 'fuuz_screen_design_source',
    description:
      'Where the screen design actually lives in the page — Apollo cache, craft editor state, or a global — and whether React fibers are reachable at all. Use this when Structure or Design is empty: it reports what was tried and what was found, rather than leaving the failure ambiguous.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      requireCapture();
      const hunt = bridged?.designHunt;
      const diag = bridged?.structureDiag;
      if (!hunt && !diag) {
        return { error: 'The panel has not reported yet. Open the Fuuz tab in the designer and wait a few seconds.' };
      }
      return {
        designInPage: hunt?.found ?? null,
        tried: hunt?.tried ?? [],
        // False in a browser means the MAIN-world hook is not installed; the
        // isolated world cannot see fibers at all, so this is the tell.
        fibersVisible: hunt?.fibersVisible ?? null,
        apolloPresent: hunt?.apolloPresent ?? null,
        structureLookup: diag ?? null,
        structureRows: (bridged?.structure ?? []).length,
        error: hunt?.error,
      };
    },
  },
  {
    name: 'fuuz_screen_screenshot',
    description:
      'Capture what the Fuuz screen looks like right now, optionally cropped to one element by name. Returns a PNG image. Captures the visible viewport only — not the whole scrollable page, and never the DevTools panel. Requires the Fuuz Dev Console panel to be open with "Connect to Claude" enabled, the Fuuz tab to be the active tab, and a build/QA environment (production pages refuse capture).',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Element name to crop to, e.g. "TicketTable". Omit for the whole viewport.' },
        maxEdge: { type: 'number', description: 'Longest edge in pixels (default 1200). Lower it to spend less context.' },
      },
    },
    async run(args) {
      const target = args.element ? { name: String(args.element) } : undefined;
      const shot = await requestCapture(target, args.maxEdge);
      if (!shot.ok || !shot.dataUrl) {
        return { error: shot.error || 'The capture failed.' };
      }
      // Returned as a real image content block so the model sees the picture
      // rather than a data: URI it cannot decode.
      return {
        __content: [{
          type: 'image',
          data: String(shot.dataUrl).replace(/^data:image\/png;base64,/, ''),
          mimeType: 'image/png',
        }],
        width: shot.width,
        height: shot.height,
        bytes: shot.bytes,
        cropped: !!shot.cropped,
      };
    },
  },
];

/* ── stdio JSON-RPC ──────────────────────────────────────────────────────── */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fuuz-dev-console', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, `Unknown tool: ${params?.name}`);
    try {
      const result = await tool.run(params.arguments ?? {});
      // A tool returning `__content` is handing back non-text blocks (an image);
      // its remaining keys travel alongside as the text summary.
      if (result && result.__content) {
        const { __content, ...rest } = result;
        return ok(id, {
          content: [
            ...__content,
            ...(Object.keys(rest).length ? [{ type: 'text', text: JSON.stringify(rest, null, 2) }] : []),
          ],
        });
      }
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return ok(id, {
        content: [{ type: 'text', text: String(err instanceof Error ? err.message : err) }],
        isError: true,
      });
    }
  }
  if (id !== undefined) fail(id, `Unsupported method: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); }
    catch { /* a malformed line is not worth killing the server over */ }
  }
});

const shutdown = () => { session?.dispose(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
