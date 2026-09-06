import { JSDOM } from 'jsdom';
import * as fs from 'fs';
const hook = fs.readFileSync('dist/hook.js', 'utf8');
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', url: 'https://admin.fuuz.app/' });
const { window } = dom;
const captured = [];
window.addEventListener('message', (e) => {
  if (e.data?.source === 'fuuz-dev-console') captured.push(e.data.event);
});
const s = window.document.createElement('script');
s.textContent = hook;
window.document.body.appendChild(s);

// Simulate the Fuuz bundle installing its own console handler AFTER us.
const pageCalls = [];
window.eval('console.debug = function (...a) { window.__pageSaw = (window.__pageSaw||0) + 1; };');
window.eval('console.debug("Transform Debugging: ", { expression: "x", trace: { property: "url" } });');

await new Promise(r => setTimeout(r, 40));
const ok = captured.length === 1 && captured[0].args[0] === 'Transform Debugging: ';
console.log('captured after page reassignment :', captured.length);
console.log('page handler still ran           :', window.__pageSaw === 1);
console.log(ok && window.__pageSaw === 1 ? 'PASS' : 'FAIL');
process.exit(ok && window.__pageSaw === 1 ? 0 : 1);
