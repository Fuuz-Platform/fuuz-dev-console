// End-to-end: extension POSTs a capture to the bridge; an MCP client reads the
// analysis back out. Proves the two halves actually meet.
import { spawn } from 'child_process';

// Never 8788: that is the developer's live bridge. A test that binds it fights
// the running session, and killing it to make room has broken the setup before.
const PORT = 8789;
const srv = spawn('node', ['src/mcp/server.cjs'], {
  env: { ...process.env, FUUZ_BRIDGE_PORT: String(PORT) }, stdio: ['pipe','pipe','pipe'] });
let buf = ''; const replies = [];
srv.stdout.on('data', d => { buf += d; let n; while ((n = buf.indexOf('\n')) >= 0) {
  const l = buf.slice(0,n).trim(); buf = buf.slice(n+1); if (l) replies.push(JSON.parse(l)); } });
const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
const wait = id => new Promise(r => { const t = setInterval(() => {
  const m = replies.find(x => x.id === id); if (m) { clearInterval(t); r(m); } }, 20); });
const call = async (id, name, args = {}) =>
  (send({ jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments: args } }),
   JSON.parse((await wait(id)).result.content[0].text));

await new Promise(r => setTimeout(r, 900));

const before = await call(1, 'fuuz_screen_status');
console.log('before push  : source =', before.source, '| hint =', !!before.hint);

// What the panel sends.
const entry = { id:'e1', seq:1, ts:'13:00:00.000', epoch:1, kind:'error', title:'Transform Error · url',
  dur:'3ms', write:'components.TusUploader.url', reads:[], level:'error',
  after:'"btoa failed"', expr:'$base64encode("… — …")', payload:[], elementType:'EmbeddedWebpage' };
const res = await fetch(`http://127.0.0.1:${PORT}/snapshot`, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({
    payload: { status:'attached', statusDetail:'', target:{title:'Asset Intake',url:'https://admin.fuuz.app/x'},
      screenName:'Asset Intake', entries:[entry], dropped:0, snapshotAt:'13:00:00.000',
      tree:[{id:'__screen__',label:'Screen',type:'Asset Intake',vk:'obj',trace:[],changed:false,
        children:[{id:'components.TusUploader.url',label:'url',type:'string',value:'"btoa failed"',vk:'err',trace:['e1'],changed:true}]}],
      design:{screenName:'Asset Intake',version:'0.0.15',coverage:{total:2,exercised:1,unexercised:[]}} },
    network: [{ id:'n1', seq:1, ts:'13:00:00.100', epoch:1, method:'POST', url:'https://api/x', path:'/application',
      status:200, durationMs:32, sizeBytes:180, failed:false, fingerprint:'a', graphqlErrors:['Cannot query field "nope"'] }],
    issues: [], designFindings: [{ id:'d1', rule:'base64-non-latin1', severity:'high',
      title:'TusUploader.url base64-encodes characters btoa cannot handle', detail:'…', count:3, entryIds:[], requestIds:[] }],
  }),
});
console.log('push         :', res.status, '(204 = accepted)');

const after = await call(2, 'fuuz_screen_status');
console.log('after push   : source =', after.source, '| screen =', after.screen,
            '| entries =', after.entries, '| requests =', after.requests, '| design =', after.design);

const issues = await call(3, 'fuuz_screen_issues');
console.log('issues       : runtime =', issues.runtime.length, '| design =', issues.design.length);
console.log('               graphql-in-200 caught:', issues.runtime.some(i => i.rule === 'graphql-error'));

const trace = await call(4, 'fuuz_screen_trace', { path: 'components.TusUploader.url' });
console.log('trace        :', trace.chain.length, 'step(s) —', trace.chain[0]?.title);

const report = await call(5, 'fuuz_screen_report');
console.log('report       :', report.markdown.length, 'chars, starts:', report.markdown.split('\n')[0]);

srv.kill();
const ok = after.source.includes('extension') && after.entries === 1 && issues.design.length === 1 && trace.chain.length === 1;
console.log('\n' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
