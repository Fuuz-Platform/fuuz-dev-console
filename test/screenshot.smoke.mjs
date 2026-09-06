// The screenshot request channel, end to end through the bridge.
//
// A screenshot is a moment rather than state, so it cannot ride the snapshot
// push — a tool call has to park a request and the panel has to answer it. This
// exercises exactly that handshake, including the failure paths, which are the
// ones a developer actually hits (panel closed, tab in the background).
import { spawn } from 'node:child_process';

const PORT = 8791;
const srv = spawn('node', ['src/mcp/server.cjs'], {
  env: { ...process.env, FUUZ_BRIDGE_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

const rpc = (id, method, params) =>
  new Promise((resolve) => {
    const seen = out.length;
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const tick = setInterval(() => {
      const fresh = out.slice(seen).trim();
      if (!fresh) return;
      for (const line of fresh.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) { clearInterval(tick); resolve(msg); }
        } catch { /* partial line */ }
      }
    }, 20);
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};

console.log('screenshot channel');

// 1. The tool is advertised.
const list = await rpc(1, 'tools/list');
const tool = list.result.tools.find((t) => t.name === 'fuuz_screen_screenshot');
check('the screenshot tool is listed', !!tool);
check('its limits are stated in the description',
  /viewport only/i.test(tool?.description ?? '') && /build\/QA/i.test(tool?.description ?? ''),
  tool?.description);

// 2. Nothing is queued until a tool asks.
const idle = await fetch(`http://127.0.0.1:${PORT}/capture`);
check('no request is parked when no tool has called', idle.status === 204);

// 3. A tool call parks a request; the panel answers it with an image.
//    1x1 transparent PNG — enough to prove the bytes survive the round trip.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const call = rpc(2, 'tools/call', {
  name: 'fuuz_screen_screenshot',
  arguments: { element: 'TicketTable', maxEdge: 800 },
});

await wait(200);
const parked = await fetch(`http://127.0.0.1:${PORT}/capture`);
const request = await parked.json();
check('the tool call parks a request the panel can collect', parked.status === 200);
check('the element crop is passed through', request?.target?.name === 'TicketTable',
  JSON.stringify(request));
check('maxEdge is passed through', request?.maxEdge === 800);

await fetch(`http://127.0.0.1:${PORT}/capture`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ok: true, dataUrl: `data:image/png;base64,${PNG}`,
    width: 1, height: 1, bytes: 68, cropped: true,
  }),
});

const reply = await call;
const content = reply.result?.content ?? [];
const image = content.find((c) => c.type === 'image');
check('the tool returns a real MCP image block', !!image, JSON.stringify(content).slice(0, 200));
check('the data: prefix is stripped, leaving raw base64', image?.data === PNG);
check('the mime type is declared', image?.mimeType === 'image/png');
check('a text block carries the dimensions alongside',
  content.some((c) => c.type === 'text' && /"cropped": true/.test(c.text)));

// 4. The queue is shallow by design — collecting clears it.
const after = await fetch(`http://127.0.0.1:${PORT}/capture`);
check('collecting a request clears it', after.status === 204);

// 5. A failure from the panel is reported, not swallowed.
const call2 = rpc(3, 'tools/call', { name: 'fuuz_screen_screenshot', arguments: {} });
await wait(200);
await fetch(`http://127.0.0.1:${PORT}/capture`);
await fetch(`http://127.0.0.1:${PORT}/capture`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ok: false, error: 'That tab is not the active one in its window.' }),
});
const reply2 = await call2;
check('a refusal surfaces its reason rather than an empty image',
  /not the active one/.test(reply2.result?.content?.[0]?.text ?? ''),
  JSON.stringify(reply2.result?.content));

srv.kill();
console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
