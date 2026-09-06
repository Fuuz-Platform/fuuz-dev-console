// Reading the Fuuz console's values out of its DOM.
//
// Written after getting this wrong: I scraped `textContent`, saw `{…}` and
// `Array(10)`, and concluded the console had elided the data. It had not — every
// key and value is its own coloured span, and `textContent` just flattens them.
// The markup below is verbatim from admin.fuuz.app.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="r"></div></body>');
global.Element = dom.window.Element;
const { readConsoleValue, readConsoleRegion } = await import('../src/core/consoleDom.ts');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};
const el = (html) => {
  const d = dom.window.document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild;
};

console.log('console DOM reader');

// The exact span structure from the page.
const one = el(`<span><span style="color: rgb(227, 110, 236); word-break: normal;">tenantId</span><span>:&nbsp;</span><span style="color: rgb(233, 63, 59); word-break: break-word;">"exampleTenantBuild"</span></span>`);
const v = readConsoleValue(one);
check('a key/value pair reads as a real value',
  JSON.stringify(v) === '{"tenantId":"exampleTenantBuild"}', JSON.stringify(v));

// Quotes are the console's rendering, not part of the string.
check('string quotes are stripped', v.tenantId === 'exampleTenantBuild', v.tenantId);

const many = el(`<span>
  <span><span style="color: rgb(227, 110, 236)">userId</span><span>: </span><span style="color: rgb(233, 63, 59)">"clbl0001"</span></span>
  <span><span style="color: rgb(227, 110, 236)">count</span><span>: </span><span>3</span></span>
  <span><span style="color: rgb(227, 110, 236)">ok</span><span>: </span><span>true</span></span>
  <span><span style="color: rgb(227, 110, 236)">missing</span><span>: </span><span>null</span></span>
</span>`);
const m = readConsoleValue(many);
// Types come from the colour and the token, so a number is not a string.
check('types are preserved, not stringified',
  m.userId === 'clbl0001' && m.count === 3 && m.ok === true && m.missing === null,
  JSON.stringify(m));

const nested = el(`<span><span style="color: rgb(227, 110, 236)">metadata</span><span>: </span><span><span><span style="color: rgb(227, 110, 236)">flowId</span><span>: </span><span style="color: rgb(233, 63, 59)">"syncBunnyAssets"</span></span><span><span style="color: rgb(227, 110, 236)">version</span><span>: </span><span style="color: rgb(233, 63, 59)">"0.0.7"</span></span></span></span>`);
const n = readConsoleValue(nested);
check('nesting builds a traversable object',
  n?.metadata?.flowId === 'syncBunnyAssets' && n?.metadata?.version === '0.0.7',
  JSON.stringify(n));

// A theme change would move the hues; losing a value to that would be worse than
// a wrong guess at its type.
const noColour = el(`<span><span>tenantId</span><span>: </span><span>"x"</span></span>`);
check('a key is still found without its colour, via the : separator',
  readConsoleValue(noColour)?.tenantId === 'x', JSON.stringify(readConsoleValue(noColour)));

// Collapsed subtrees genuinely are not in the DOM — a real limit, and a different
// one from "the values are elided", which was the wrong conclusion.
const region = dom.window.document.createElement('div');
region.innerHTML = `<div><span><span style="color: rgb(227,110,236)">a</span><span>: </span><span>1</span></span></div><div><span>Array(10)</span></div>`;
const read = readConsoleRegion(region);
check('rows are read from a region', read.count === 2, String(read.count));
check('a collapsed subtree is reported, not silently dropped', read.hasCollapsed === true);

/* ── Collapsed rows must be refused, not rendered ─────────────────────────── */

const { readExpandedRow, isUsableRead } = await import('../src/core/consoleDom.ts');

console.log('\ncollapsed rows');

// This is what a collapsed flow log row looks like: a name, then expander glyphs
// with labels and no values. Reading it structurally produced `0: "▶"` array items,
// which looked like data and was not.
const collapsed = el(`<div><span>To Library List</span><span><span>▶</span><span>input: </span></span><span><span>▶</span><span>output: </span></span><span><span>▶</span><span>more: </span></span></div>`);
check('a collapsed row is refused rather than rendered as a tree',
  readExpandedRow(collapsed) === undefined, JSON.stringify(readExpandedRow(collapsed)));

check('expander glyphs are not usable content', isUsableRead('▶') === false);
check('a bare length is not usable content', isUsableRead('(8)') === false);
check('an empty string is not usable content', isUsableRead('') === false);
check('real values are usable', isUsableRead({ tenantId: 'exampleTenantBuild' }) === true);

// An expanded row still reads, which is the whole point of keeping the reader.
const expanded = el(`<div><span><span style="color: rgb(227,110,236)">tenantId</span><span>: </span><span style="color: rgb(233,63,59)">"exampleTenantBuild"</span></span></div>`);
check('an expanded row still reads normally',
  readExpandedRow(expanded)?.tenantId === 'exampleTenantBuild',
  JSON.stringify(readExpandedRow(expanded)));

console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
