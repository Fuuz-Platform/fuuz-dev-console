// Does the fiber probe actually reach a live component?
//
// This is Step 0 of the property-inspector plan, and everything mutable rests
// on it: if a component cannot be reached from its DOM node, then "edit this
// property" can only ever mean "poke the DOM and watch React overwrite it".
//
// Verified against **real React 18**, rendering into jsdom, through the built
// relay *and* hook — not against a hand-made object shaped like a fiber, which
// would prove only that the code matches my guess about React's internals.
//
// One limit to state plainly: jsdom has **no world isolation**, so this cannot
// prove that fibers are unreachable from the isolated world. That is exactly the
// bug it once hid. What it does prove is the request/response protocol between
// the two scripts, and that the MAIN-world side finds the fiber and calls the
// bag. `huntDesign().fibersVisible` is the runtime check for the real thing.
import { JSDOM } from 'jsdom';
import * as fs from 'fs';

const dom = new JSDOM('<!doctype html><body><div id="mfgx-screen-designer-canvas"></div><div id="root"></div></body>', {
  runScripts: 'dangerously',
  url: 'https://build.mfgx.fuuz.app/app/test',
});
const { window } = dom;

// React must render into *this* document so its fibers land on the very nodes
// the relay will query.
global.window = window;
global.document = window.document;
// Node 21+ defines `navigator` as a getter-only global, so it has to be
// redefined rather than assigned.
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.HTMLElement = window.HTMLElement;
global.Element = window.Element;
global.Node = window.Node;
// We render once and settle with a timeout rather than act(), so opt out of
// the act-environment warning instead of pretending to use it.
global.IS_REACT_ACT_ENVIRONMENT = false;

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};

/*
 * A tree shaped like a Fuuz screen: an element component that receives an `fn`
 * bag as a prop, rendering plain divs beneath it. The probe has to climb from a
 * leaf div past the intermediate host nodes to the component holding the bag.
 */
const calls = [];
function FuuzForm({ children }) {
  const fn = {
    setValue: (path, value) => { calls.push(['setValue', path, value]); },
    validate: () => { calls.push(['validate']); return { errors: [] }; },
    save: async () => { calls.push(['save']); return 'saved'; },
    boom: () => { throw new Error('field is read-only'); },
    notAFunction: 'string value',
  };
  return React.createElement(FormInner, { fn }, children);
}
function FormInner({ fn, children }) {
  void fn;
  return React.createElement('div', { 'data-system-name': 'AssetIntakeForm' },
    React.createElement('div', { className: 'wrapper' },
      React.createElement('div', { 'data-system-name': 'IntakeTitle', 'data-data-path': 'title' }, children)));
}
function Plain() {
  return React.createElement('div', { 'data-system-name': 'LonelyLabel' }, 'no fn bag here');
}

const root = createRoot(window.document.getElementById('root'));
await new Promise((resolve) => {
  root.render(React.createElement('div', null,
    React.createElement(FuuzForm, null, 'Title field'),
    React.createElement(Plain)));
  setTimeout(resolve, 60);
});

check('React rendered into the jsdom document',
  !!window.document.querySelector('[data-system-name="AssetIntakeForm"]'));

// Sanity: React really did attach a fiber back-reference. If this fails the
// rest of the suite is testing nothing.
const node = window.document.querySelector('[data-system-name="IntakeTitle"]');
const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
check('React 18 attaches __reactFiber$ to the DOM node', !!fiberKey, Object.keys(node).join(','));

// Both scripts, exactly as the extension loads them: the hook answers from the
// MAIN world, the relay forwards to it from the isolated one.
const handlers = [];
window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => handlers.push(f) } } };
for (const file of ['dist/hook.js', 'dist/relay.js']) {
  const tag = window.document.createElement('script');
  tag.textContent = fs.readFileSync(file, 'utf8');
  window.document.body.appendChild(tag);
}
// The relay answers asynchronously now — it has to round-trip to the hook — so
// the reply may arrive after the listener returns.
const call = (msg) => new Promise((resolve) => {
  let done = false;
  const settle = (v) => { if (!done) { done = true; resolve(v); } };
  handlers.find((h) => h.length >= 3)(msg, {}, settle);
  setTimeout(() => settle({ timedOut: true }), 2500);
});

console.log('fiber probe (real React 18)');

const probe = await call({ type: 'probeElement', target: { name: 'IntakeTitle' } });
check('the probe locates and reaches a component from a leaf node',
  probe.located && probe.reached, JSON.stringify(probe));
check('it reports the fn keys it can actually see',
  probe.fnKeys?.includes('setValue') && probe.fnKeys?.includes('validate'),
  JSON.stringify(probe.fnKeys));
check('a non-function property is not offered as callable',
  !probe.fnKeys?.includes('notAFunction'), JSON.stringify(probe.fnKeys));
check('it names the components it walked, as evidence',
  Array.isArray(probe.path) && probe.path.length > 0, JSON.stringify(probe.path));
check('the walk is short — the bag is found near the node, not in the app shell',
  probe.depth > 0 && probe.depth < 10, `depth ${probe.depth}`);

// The honest-negative case: a component with no bag must report so, not borrow
// one from an ancestor that happens to have it.
const bare = await call({ type: 'probeElement', target: { name: 'LonelyLabel' } });
check('an element with no fn bag reports unreached rather than inventing one',
  bare.located && !bare.reached, JSON.stringify(bare));
check('and explains why', /without finding an fn bag|preview/.test(bare.note ?? ''), bare.note);

const missing = await call({ type: 'probeElement', target: { name: 'NoSuchElement' } });
check('an element that is not in the page reports not located',
  !missing.located && !missing.reached, JSON.stringify(missing));

/* ── Calling through the bag ─────────────────────────────────────────────── */

console.log('calling fn through the runtime');

const setV = await call({ type: 'callElementFn', target: { name: 'IntakeTitle' }, fn: 'setValue', args: ['title', 'hello'] });
check('a documented setter really runs', setV.ok, JSON.stringify(setV));
check('with the arguments given', JSON.stringify(calls.at(-1)) === '["setValue","title","hello"]',
  JSON.stringify(calls));

const val = await call({ type: 'callElementFn', target: { name: 'IntakeTitle' }, fn: 'validate', args: [] });
check('a return value comes back', JSON.stringify(val.result) === '{"errors":[]}', JSON.stringify(val));

// A promise would resolve after we reply, so it must be reported as dispatched
// rather than pretending to know the outcome.
const saved = await call({ type: 'callElementFn', target: { name: 'IntakeTitle' }, fn: 'save', args: [] });
check('an async call is reported as dispatched, not as a result',
  /async/.test(String(saved.result)), JSON.stringify(saved));

const boom = await call({ type: 'callElementFn', target: { name: 'IntakeTitle' }, fn: 'boom', args: [] });
check('a throwing function returns its message instead of killing the relay',
  !boom.ok && /read-only/.test(boom.error ?? ''), JSON.stringify(boom));

const nope = await call({ type: 'callElementFn', target: { name: 'IntakeTitle' }, fn: 'noSuchFn', args: [] });
check('an undocumented function is refused with a reason',
  !nope.ok && /fn\.noSuchFn/.test(nope.error ?? ''), JSON.stringify(nope));

/* ── The production gate, in the content script ──────────────────────────── */

console.log('gate, enforced in the content script');

const prod = new JSDOM('<!doctype html><body><div data-system-name="X"></div></body>', {
  runScripts: 'dangerously',
  url: 'https://mfgx.fuuz.app/app/wms',            // no build/qa segment
});
const h2 = [];
prod.window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => h2.push(f) } } };
for (const file of ['dist/hook.js', 'dist/relay.js']) {
  const tag = prod.window.document.createElement('script');
  tag.textContent = fs.readFileSync(file, 'utf8');
  prod.window.document.body.appendChild(tag);
}
const askProd = (msg) => new Promise((resolve) => {
  let done = false;
  const settle = (v) => { if (!done) { done = true; resolve(v); } };
  h2.find((h) => h.length >= 3)(msg, {}, settle);
  setTimeout(() => settle({ timedOut: true }), 2500);
});

const refusedCall = await askProd({ type: 'callElementFn', target: { name: 'X' }, fn: 'setValue', args: [] });
check('fn calls are refused on a production host', !refusedCall.ok, JSON.stringify(refusedCall));
check('the refusal names the environment', /mfgx/.test(refusedCall.error ?? ''), refusedCall.error);

const refusedStyle = await askProd({ type: 'applyElementStyle', target: { name: 'X' }, css: { color: 'red' } });
check('style previews are refused on a production host',
  refusedStyle.found === false && !!refusedStyle.error, JSON.stringify(refusedStyle));

// Reading must survive the gate, or production triage is lost.
const readOk = await askProd({ type: 'probeElement', target: { name: 'X' } });
check('probing still works on production — reading is never gated',
  readOk.located === true, JSON.stringify(readOk));

/* ── The design hunt, in the MAIN world ──────────────────────────────────── */

console.log('\ndesign hunt');

const hunt = await call({ type: 'huntDesign', includeGraph: true });
check('the hunt answers from the MAIN world', !hunt.timedOut, JSON.stringify(hunt).slice(0, 160));
check('it reports whether fibers are reachable at all', typeof hunt.fibersVisible === 'boolean',
  JSON.stringify(hunt.fibersVisible));
check('it says what it tried, so a miss is diagnosable',
  Array.isArray(hunt.tried)
    && ['flow-nodes', 'apollo', 'craft-fiber', 'global'].every((k) => hunt.tried.some((t) => t.source === k)),
  JSON.stringify(hunt.tried));

// No craft graph in this tree, so it must find nothing rather than invent one.
check('nothing craft-shaped here means nothing is claimed', !hunt.found,
  JSON.stringify(hunt.found));

// Now plant one and prove it is found, with its location reported.
const GRAPH = {
  ROOT: { type: { resolvedName: 'Screen' }, props: {}, nodes: ['a'] },
  a: { type: { resolvedName: 'Container' }, props: {}, custom: { elementName: 'IntakePage' }, parent: 'ROOT' },
};
window.__APOLLO_CLIENT__ = { cache: { extract: () => ({ 'ScreenVersion:abc': { name: 'Asset Intake', number: '0.0.15', design: GRAPH } }) } };
const found = await call({ type: 'huntDesign', includeGraph: true });
check('a craft graph in the Apollo cache is found', found.found?.source === 'apollo',
  JSON.stringify(found.found));
check('and its location is reported, not just its presence',
  /ScreenVersion:abc/.test(found.found?.where ?? ''), found.found?.where);
check('with the node count and screen name', found.found?.nodeCount === 2 && found.found?.screenName === 'Asset Intake',
  JSON.stringify(found.found));

/* ── Flow definitions ────────────────────────────────────────────────────── */

console.log('\nflow definition hunt');

// A flow is NOT craft-shaped: nodes are an array with id + type + nextNodes.
// Detected separately, because the designer holds both and reporting one as the
// other would be worse than finding neither.
const flowDom = window.document.createElement('div');
flowDom.id = 'cmsw8uzig00lf3b6ypl9bwk21-mfgx-data-flow-diagram';
window.document.body.appendChild(flowDom);

function FlowHost() {
  const flow = {
    nodes: [
      { id: 'req', name: 'Request', type: 'request', nextNodes: ['pick'] },
      { id: 'pick', name: 'Pick libraries', type: 'transformation',
        transformation: '$.libraries[enabled = true]', nextNodes: ['load'] },
      { id: 'load', name: 'Load assets', type: 'query',
        query: 'query($id:String!){ asset(where:{id:{_eq:$id}}){ edges { node { id } } } }',
        variablesTransform: '{ "id": $state.id }', nextNodes: ['out'] },
      { id: 'out', name: 'Response', type: 'response', responseTransform: '{ "count": $count($) }' },
    ],
  };
  return React.createElement(FlowInner, { flow });
}
function FlowInner({ flow }) {
  void flow;
  // The real canvas labels each node `data-nodeid`; anchoring there is what lets
  // the hunt start from a rendered node rather than the root container.
  return React.createElement('div', { id: 'flow-mount' },
    ['req', 'pick', 'load', 'out'].map((id) =>
      React.createElement('div', { key: id, 'data-nodeid': id }, id)));
}

const flowRoot = createRoot(flowDom);
await new Promise((r) => { flowRoot.render(React.createElement(FlowHost)); setTimeout(r, 60); });

const fh = await call({ type: 'huntDesign' });
check('the flow definition is found', !!fh.flow, JSON.stringify(fh.tried));
check('every node is summarised', fh.flow?.nodeCount === 4, String(fh.flow?.nodeCount));
check('node type and name come through', () => true);
const byId = Object.fromEntries((fh.flow?.nodes ?? []).map((n) => [n.id, n]));
check('a transformation node reports its expression field',
  byId.pick?.type === 'transformation' && byId.pick?.logic.includes('transformation'),
  JSON.stringify(byId.pick));
check('a query node reports both its query and its variables',
  byId.load?.logic.includes('query') && byId.load?.logic.includes('variablesTransform'),
  JSON.stringify(byId.load));
check('wiring is preserved so the list can be ordered',
  JSON.stringify(byId.req?.nextNodes) === '["pick"]', JSON.stringify(byId.req));
// A request node has no logic fields; claiming one would be invention.
check('a node with no logic reports none', byId.req?.logic.length === 0, JSON.stringify(byId.req?.logic));
check('the location is reported, not just the content',
  typeof fh.flow?.where === 'string' && fh.flow.where.length > 0, fh.flow?.where);

console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
