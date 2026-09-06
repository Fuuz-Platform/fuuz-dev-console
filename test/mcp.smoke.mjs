import { spawn } from 'child_process';
// Its own port, so running tests never disturbs the developer's live bridge.
const srv = spawn('node', ['src/mcp/server.cjs'], {
  cwd: process.cwd(),
  env: { ...process.env, FUUZ_BRIDGE_PORT: '8790' },
  stdio: ['pipe','pipe','pipe'],
});
let buf = ''; const replies = [];
srv.stdout.on('data', d => { buf += d; let n; while ((n = buf.indexOf('\n')) >= 0) {
  const l = buf.slice(0,n).trim(); buf = buf.slice(n+1); if (l) replies.push(JSON.parse(l)); } });
srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
const wait = id => new Promise(r => { const t = setInterval(() => {
  const m = replies.find(x => x.id === id); if (m) { clearInterval(t); r(m); } }, 20); });

send({ jsonrpc:'2.0', id:1, method:'initialize', params:{} });
const init = await wait(1);
console.log('server     :', init.result.serverInfo.name, init.result.serverInfo.version);
console.log('capabilities:', JSON.stringify(init.result.capabilities));

send({ jsonrpc:'2.0', id:2, method:'tools/list' });
const list = await wait(2);
console.log('\ntools:');
for (const t of list.result.tools) console.log('  ' + t.name.padEnd(24) + t.description.split('.')[0].slice(0,72));

// Calling before attach must be a clean error, not a crash.
send({ jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'fuuz_screen_issues', arguments:{} } });
const guard = await wait(3);
console.log('\nguard before attach :', guard.result.isError === true, '|', guard.result.content[0].text);

send({ jsonrpc:'2.0', id:4, method:'tools/call', params:{ name:'nope', arguments:{} } });
const unknown = await wait(4);
console.log('unknown tool        :', !!unknown.error, '|', unknown.error?.message);
srv.kill(); process.exit(0);
