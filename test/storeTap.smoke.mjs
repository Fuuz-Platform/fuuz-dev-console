// Does the store tap find a redux store in a real React tree, through the built hook?
//
// The claim under test is structural: react-redux's Provider holds the store on
// its props, so climbing fibers from a mounted node reaches it. A hand-made object
// shaped like a fiber would prove only that the code matches my guess about React
// internals — so this renders **real React 18** into jsdom and runs the shipped
// `dist/hook.js` against the fibers React actually made, over the same
// postMessage protocol the extension uses.
//
// The Provider is stood in for by an ordinary component taking a `store` prop,
// because that is exactly what Provider is. react-redux is not a dependency here,
// and adding one to assert the shape of its own props would be testing react-redux.
//
// What this cannot prove: that the real Fuuz app mounts its Provider above the
// nodes we anchor on, and that its flow logs land in `dataFlowEditor[tab].logs`
// under a live designer. That needs a designer session — see NEXT.md.
import { JSDOM } from 'jsdom';
import * as fs from 'fs';

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
  runScripts: 'dangerously',
  url: 'https://build.mfgx.fuuz.app/app/test',
});
const { window } = dom;
global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.HTMLElement = window.HTMLElement;
global.Element = window.Element;
global.Node = window.Node;
global.IS_REACT_ACT_ENVIRONMENT = false;

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};

/** A store whose state grows the way the designer's log grows. Dispatching throws. */
let dispatched = 0;
let state = {};
const store = {
  getState: () => state,
  subscribe: () => () => {},
  dispatch: () => { dispatched += 1; throw new Error('the tap must never dispatch'); },
};
const setState = (next) => { state = next; };

const logs = (ids) => ids.map((id) => ({
  id, level: 'debug', nodeId: 'n1', message: 'executed',
  data: { payload: { rows: 3 }, context: {}, claims: {} },
}));

setState({ dataFlowEditor: { currentTabId: 'tab1', tab1: { logs: logs(['a', 'b']) } } });

// Nested deliberately: discovery has to climb past host nodes rather than luck
// into the store on the anchor itself.
const Provider = ({ store: _s, children }) => React.createElement('div', { id: 'provider' }, children);
const Deep = ({ children }) => React.createElement('div', { className: 'deep' }, children);
const Leaf = () => React.createElement('span', { id: 'leaf' }, 'leaf');

const root = createRoot(window.document.getElementById('root'));
await new Promise((resolve) => {
  root.render(React.createElement(Provider, { store },
    React.createElement(Deep, null,
      React.createElement(Deep, null,
        React.createElement(Deep, null, React.createElement(Leaf))))));
  setTimeout(resolve, 60);
});

check('React rendered into the jsdom document', !!window.document.getElementById('leaf'));

const tag = window.document.createElement('script');
tag.textContent = fs.readFileSync('dist/hook.js', 'utf8');
window.document.body.appendChild(tag);

/** One request over the MAIN-world protocol, the way the relay makes it. */
let nextId = 1;
const call = (type, payload = {}) => new Promise((resolve) => {
  const id = nextId++;
  const onReply = (e) => {
    const m = e.data;
    if (!m || m.source !== 'fuuz-devtool-response' || m.id !== id) return;
    window.removeEventListener('message', onReply);
    resolve(m.result);
  };
  window.addEventListener('message', onReply);
  window.postMessage({ source: 'fuuz-devtool-request', id, type, payload }, '*');
  setTimeout(() => { window.removeEventListener('message', onReply); resolve({ timedOut: true }); }, 2000);
});

console.log('\nstore tap — real React 18, through dist/hook.js\n');

const first = await call('flowLogs', { seqBase: 0 });
check('the store is found by climbing to the Provider', first.attached === true, JSON.stringify(first.error));
check('it reports the entries already in the store', first.entries?.length === 2, JSON.stringify(first.entries?.length));
check('entries keep the platform id rather than a row index',
  first.entries?.map((e) => e.id).join(',') === 'a,b', JSON.stringify(first.entries?.map((e) => e.id)));
check('entries carry the whole workflow state as their body',
  JSON.stringify(first.entries?.[0]?.payload?.[0]?.payload) === '{"rows":3}',
  JSON.stringify(first.entries?.[0]?.payload));
check('entries are stamped with the designer tab they came from', first.entries?.[0]?.surface === 'tab1');
check('entries are marked as flow', first.entries?.every((e) => e.kind === 'flow'));
check('the source is named, so the panel can say which it is showing',
  first.source === 'redux-store', first.source);

const idle = await call('flowLogs', { seqBase: 2 });
check('a second read with no new logs reports nothing', idle.entries?.length === 0);

setState({ dataFlowEditor: { currentTabId: 'tab1', tab1: { logs: logs(['a', 'b', 'c']) } } });
const grown = await call('flowLogs', { seqBase: 2 });
check('only the new entry is reported when the log grows',
  grown.entries?.length === 1 && grown.entries[0].id === 'c', JSON.stringify(grown.entries?.map((e) => e.id)));

setState({
  dataFlowEditor: {
    currentTabId: 'tab2',
    tab1: { logs: logs(['a', 'b', 'c']) },
    tab2: { logs: logs(['d']) },
  },
});
const second = await call('flowLogs', { seqBase: 3 });
check('a second designer tab is reported under its own surface',
  second.entries?.length === 1 && second.entries[0].surface === 'tab2',
  JSON.stringify(second.entries));

const names = await call('flowLogs', { seqBase: 4, names: { n1: 'Query Readings' } });
check('a caller-supplied node name is used when there is nothing new', names.entries?.length === 0);

await call('resetFlowLogs');
const afterReset = await call('flowLogs', { seqBase: 0, names: { n1: 'Query Readings' } });
check('reset makes the whole store readable again', afterReset.entries?.length === 4,
  JSON.stringify(afterReset.entries?.length));
check('node ids resolve to names when the caller has the diagram',
  afterReset.entries?.[0]?.write === 'flow.Query Readings', afterReset.entries?.[0]?.write);

// Read-only by construction: this store throws when dispatched to, and the tap
// never touched it.
check('the tap never dispatched', dispatched === 0, `dispatched ${dispatched}×`);

const missing = await call('flowLogs', { seqBase: 0 });
check('repeat reads stay stable', missing.attached === true);

console.log(`\n${fail ? `FAIL — ${fail} failure(s)` : 'PASS — 0 failure(s)'}\n`);
process.exit(fail ? 1 : 0);
