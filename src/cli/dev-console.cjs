#!/usr/bin/env node
/**
 * Fuuz Dev Console, without a browser extension.
 *
 * The capture engine (`src/screenrunner/session.ts`) deliberately takes plain
 * options and reports through a callback, so it runs anywhere Node does. This
 * wraps it in a CLI: attach to any Fuuz page in any browser, classify its
 * console, and print the execution log plus the state it produced.
 *
 *   node scripts/dev-console.cjs --open https://admin.fuuz.app/...
 *
 * Requires a build first: `npm run compile` (or `npx tsc -p tsconfig.test.json`).
 */
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', '..', 'out', 'src', 'node');
if (!fs.existsSync(path.join(OUT, 'session.js'))) {
  console.error('Build first:  npm run compile:node');
  process.exit(1);
}
const { ScreenRunnerSession } = require(path.join(OUT, 'session.js'));
const CORE = path.join(__dirname, '..', '..', 'out', 'src', 'core');
const { mergeRules } = require(path.join(CORE, 'classify.js'));
const { indexScreenDesign } = require(path.join(CORE, 'designJoin.js'));

/* ── args ─────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

if (has('help')) {
  console.log(`Fuuz Dev Console — attach to a Fuuz page and read its console as state.

  --open <url>       URL to open when launching Chrome
  --url <filter>     tab URL/title to attach to (regex or substring; default: the --open value, else fuuz.app)
  --port <n>         DevTools port (default 9222)
  --design <file>    screen design JSON to join against (element names, types, coverage)
  --profile <dir>    Chrome profile dir (default ./.dev-console-profile — persists your login)
  --chrome <path>    Chrome binary (default: auto-detect)
  --no-launch        attach only; never start a browser
  --json             emit one JSON object per entry (NDJSON) instead of pretty output
  --quiet            suppress the live log; print only the final state tree
  --dump <file>      write the final payload (entries + state tree + coverage) as JSON
  --serve [port]     serve the live console at http://127.0.0.1:<port> (default 8777)

Ctrl-C prints the state tree and design coverage.`);
  process.exit(0);
}

const design = flag('design') ? indexScreenDesign(JSON.parse(fs.readFileSync(flag('design'), 'utf8'))) : undefined;
const openUrl = flag('open');

const options = {
  port: Number(flag('port', 9222)),
  urlFilter: flag('url', openUrl || 'fuuz.app'),
  targetUrl: openUrl,
  chromePath: flag('chrome'),
  userDataDir: path.resolve(flag('profile', '.dev-console-profile')),
  rules: mergeRules([]),
  maxEntries: Number(flag('max', 5000)),
  autoLaunch: !has('no-launch'),
  design,
};

/* ── live server ──────────────────────────────────────────────────────────
 * Serves the same React bundle the VS Code panel loads, and streams payloads to
 * it over SSE — so the browser console is live rather than a frozen snapshot.
 */

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const clients = new Set();
let onCommand = () => {};

function serve(port) {
  const http = require('http');
  const assets = {
    '/': path.join(__dirname, 'preview', 'index.html'),
    '/index.html': path.join(__dirname, 'preview', 'index.html'),
    '/screenrunner.js': path.join(__dirname, '..', '..', 'dist', 'panel.js'),
    '/screenrunner.css': path.join(__dirname, '..', '..', 'dist', 'panel.css'),
  };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    // Allow a page on https://…fuuz.app to reach this loopback server. Chrome
    // treats 127.0.0.1 as trustworthy, but a cross-origin fetch still needs CORS
    // and a Private Network Access opt-in.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      if (last) res.write(`data: ${JSON.stringify(last)}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url === '/command' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { onCommand(JSON.parse(body)); } catch { /* ignore a malformed command */ }
        res.writeHead(204); res.end();
      });
      return;
    }

    const file = assets[url];
    if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`${C.green}▸${C.off} live console: ${C.bold}http://127.0.0.1:${port}${C.off}`);
  });
  return server;
}

/** Push the newest payload to every attached browser. */
function broadcast(payload) {
  if (!clients.size) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
}

/* ── output ───────────────────────────────────────────────────────────── */

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', amber: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[36m', purple: '\x1b[35m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' }
  : new Proxy({}, { get: () => '' });

const KIND = {
  query: [C.blue, 'Q'], debug: [C.purple, 'ƒ'], flow: [C.green, '▶'],
  error: [C.red, '!'], log: [C.dim, '·'],
};

let printed = 0;
let last = null;

function render(payload) {
  last = payload;
  broadcast(payload);
  if (has('quiet')) return;
  // A main-frame navigation clears the buffer; without resetting the cursor the
  // next run's entries are silently swallowed until it exceeds the old count.
  if (payload.entries.length < printed) printed = 0;
  for (const e of payload.entries.slice(printed)) {
    if (has('json')) { console.log(JSON.stringify(e)); continue; }
    const [colour, badge] = KIND[e.kind] || KIND.log;
    const write = e.write ? ` ${C.dim}→${C.off} ${e.write}` : '';
    const type = e.elementType ? ` ${C.dim}[${e.elementType}${e.remote ? ' remote' : ''}]${C.off}` : '';
    const dur = e.dur ? ` ${C.dim}${e.dur}${C.off}` : '';
    console.log(`${C.dim}${e.ts}${C.off} ${colour}${badge}${C.off} ${e.title}${dur}${write}${type}`);
    if (e.after !== undefined && e.write) console.log(`             ${C.dim}=${C.off} ${e.after}`);
  }
  printed = payload.entries.length;
}

/** The state tree, as an indented outline. */
function printTree(nodes, depth = 0) {
  for (const n of nodes) {
    const mark = n.changed ? `${C.amber}•${C.off}` : ' ';
    const trace = n.trace.length ? ` ${C.amber}⌁${n.trace.length}${C.off}` : '';
    const value = n.value ? ` ${C.dim}=${C.off} ${n.value}` : '';
    console.log(`${mark} ${'  '.repeat(depth)}${n.label} ${C.dim}${n.type}${C.off}${value}${trace}`);
    if (n.children) printTree(n.children, depth + 1);
  }
}

function summary() {
  if (!last) return;
  const dump = flag('dump');
  if (dump) {
    fs.writeFileSync(dump, JSON.stringify(last, null, 2));
    console.log(`\nwrote ${dump} (${last.entries.length} entries)`);
  }
  console.log(`\n${C.bold}── State (${last.snapshotAt}) ──${C.off}`);
  if (last.tree.length) printTree(last.tree);
  else console.log(`${C.dim}(nothing captured)${C.off}`);

  if (last.design) {
    const { exercised, total, unexercised } = last.design.coverage;
    console.log(`\n${C.bold}── Design: ${last.design.screenName}${last.design.version ? ` v${last.design.version}` : ''} ──${C.off}`);
    console.log(`${exercised}/${total} dynamic props evaluated`);
    for (const u of unexercised) {
      console.log(`  ${C.dim}never ran:${C.off} ${u.elementName}.${u.property} ${C.dim}(${u.elementType})${C.off}`);
    }
  }
  console.log(`\n${last.entries.length} entries${last.dropped ? `, ${last.dropped} dropped` : ''}.`);
}

/* ── run ──────────────────────────────────────────────────────────────── */

let ready = false;
const session = new ScreenRunnerSession(options, (payload) => {
  if (payload.status !== 'attached' && !ready) {
    console.error(`${C.dim}${payload.status}: ${payload.statusDetail}${C.off}`);
    if (payload.status === 'error') process.exitCode = 1;
  }
  if (payload.status === 'attached' && !ready) {
    ready = true;
    console.error(`${C.green}✓${C.off} ${payload.statusDetail}  ${C.dim}(Ctrl-C for the state tree)${C.off}\n`);
  }
  render(payload);
});

let closing = false;
const finish = () => {
  if (closing) return;
  closing = true;
  summary();
  session.dispose();
  process.exit(process.exitCode || 0);
};
process.on('SIGINT', finish);
process.on('SIGTERM', finish);

if (has('serve')) {
  serve(Number(flag('serve', 8777)));
  onCommand = (msg) => {
    if (msg.type === 'clear') session.clear();
    if (msg.type === 'reattach') void session.reattach();
    if (msg.type === 'dumpRaw') {
      const file = `dev-console-raw-${Date.now()}.json`;
      fs.writeFileSync(file, JSON.stringify(session.rawEvents(), null, 2));
      console.error(`${C.dim}wrote ${file}${C.off}`);
    }
  };
}

session.start().then(() => {
  // A one-shot run: capture for `--for` seconds, then report and exit.
  const seconds = Number(flag('for', 0));
  if (seconds > 0) setTimeout(finish, seconds * 1000);
});
