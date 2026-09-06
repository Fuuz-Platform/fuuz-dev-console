// Reading the App Designer's own structure tree.
//
// Runs against markup captured live from admin.fuuz.app, through the built
// relay — so it exercises the same code path the extension does, not a
// reimplementation of it.
import { JSDOM } from 'jsdom';
import * as fs from 'fs';

const relay = fs.readFileSync('dist/relay.js', 'utf8');
const panel = fs.readFileSync('test/fixtures/designer-structure.html', 'utf8');

// The tree only renders inside the screen designer, and the relay only scrapes
// it there — so the canvas has to be present for any of this to fire.
const dom = new JSDOM(
  `<!doctype html><body><div id="mfgx-screen-designer-canvas"></div>${panel}
   <button data-tab-id="cmsvt7hww002k3b6xvit7djw0"><p>Asset Intake</p></button></body>`,
  { runScripts: 'dangerously', url: 'https://admin.fuuz.app/system/configuration/applicationDesigner' }
);
const { window } = dom;
const handlers = [];
window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => handlers.push(f) } } };
const s = window.document.createElement('script');
s.textContent = relay;
window.document.body.appendChild(s);
const call = (msg) => new Promise((r) => handlers[0](msg, {}, r));

let fail = 0;
const check = (label, fn) => {
  try { fn(); console.log('  ✓ ' + label); }
  catch (e) { fail++; console.error('  ✗ ' + label + '\n      ' + e.message); }
};
const eq = (a, b, what) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${what}: expected ${y}, got ${x}`);
};

console.log('designer structure tree');
const reply = await call({ type: 'getDesignerSurface' });
const tree = reply.domStructure;

check('the screen designer is detected', () => eq(reply.designer, 'screen', 'designer'));
check('the tree is found and parsed', () => {
  if (!tree) throw new Error('domStructure missing from the probe reply');
});

check('one root, carrying the craft node id', () => {
  eq(tree.roots.length, 1, 'root count');
  eq(tree.roots[0].nodeId, 'ROOT', 'root node id');
  eq(tree.roots[0].name, 'Screen', 'root name');
});

// The child <li> sits under ul[role=group] > MuiCollapse-wrapper >
// MuiCollapse-wrapperInner > div, so a direct-children walk finds nothing.
check('children are found through the MuiCollapse wrappers', () => {
  eq(tree.roots[0].children.length, 1, 'child count');
  eq(tree.roots[0].children[0].nodeId, 'IntakePage00', 'child node id');
  eq(tree.roots[0].children[0].name, 'IntakePage', 'child name');
});

check('the row icon gives a category', () => eq(tree.roots[0].category, 'Layout', 'category'));

check('the claimed child count is read from the row', () => {
  eq(tree.roots[0].childCount, 10, 'root childCount');
  eq(tree.roots[0].children[0].childCount, 10, 'child childCount');
});

// This is the whole reason the scrape must announce itself: IntakePage00 says
// it has 10 children and renders none, because it is collapsed.
check('a collapsed row is counted as incomplete, not as a leaf', () => {
  eq(tree.roots[0].children[0].expanded, false, 'expanded');
  eq(tree.roots[0].children[0].children.length, 0, 'rendered children');
  eq(tree.collapsed, 1, 'collapsed tally');
});

check('the selected row is the one the developer clicked', () => {
  eq(tree.roots[0].selected, true, 'root selected');
  eq(tree.roots[0].children[0].selected, false, 'child selected');
});

check('an active filter that hides everything is reported', () =>
  eq(tree.filteredEmpty, true, 'filteredEmpty'));

check('quick-action buttons are not mistaken for element names', () => {
  const names = [tree.roots[0].name, tree.roots[0].children[0].name];
  if (names.some((n) => /Quick actions|app components/.test(n))) {
    throw new Error(`a control title leaked into a name: ${JSON.stringify(names)}`);
  }
});

check('every row is counted', () => eq(tree.count, 2, 'count'));

// The tree's own presence is the evidence, not the canvas id. Gating on
// `#mfgx-screen-designer-canvas` meant any change to that id silently cost us
// the structure sitting right there in the DOM — so a tree with rows counts as
// the screen designer even when the canvas is not found.
const noCanvas = new JSDOM(`<!doctype html><body>${panel}</body>`,
  { runScripts: 'dangerously', url: 'https://admin.fuuz.app/system/configuration/applicationDesigner' });
const h2 = [];
noCanvas.window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => h2.push(f) } } };
const s2 = noCanvas.window.document.createElement('script');
s2.textContent = relay;
noCanvas.window.document.body.appendChild(s2);
const off = await new Promise((r) => h2[0]({ type: 'getDesignerSurface' }, {}, r));
check('a tree without a canvas is still read', () => {
  eq(off.designer, 'screen', 'designer');
  eq(off.domStructure?.count, 2, 'rows');
  eq(off.probe.canvas, false, 'canvas found');
  eq(off.probe.tree, true, 'tree found');
});

// The real negative: no tree anywhere means nothing to report, and claiming a
// structure would show a stale tree for a flow or schema tab.
const bare = new JSDOM('<!doctype html><body><p>nothing here</p></body>',
  { runScripts: 'dangerously', url: 'https://admin.fuuz.app/home' });
const h4 = [];
bare.window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => h4.push(f) } } };
const s4 = bare.window.document.createElement('script');
s4.textContent = relay;
bare.window.document.body.appendChild(s4);
const none = await new Promise((r) => h4[0]({ type: 'getDesignerSurface' }, {}, r));
check('no tree, no scrape', () => {
  eq(none.designer, null, 'designer');
  eq(none.domStructure, undefined, 'domStructure');
  eq(none.probe.rows, 0, 'rows');
});

/* ── The expanded tree, three levels deep ────────────────────────────────── */

console.log('\nexpanded tree (real, two levels open)');

const expanded = fs.readFileSync('test/fixtures/designer-structure-expanded.html', 'utf8');
const dom2 = new JSDOM(
  `<!doctype html><body><div id="mfgx-screen-designer-canvas"></div>${expanded}</body>`,
  { runScripts: 'dangerously', url: 'https://admin.fuuz.app/system/configuration/applicationDesigner' }
);
const h3 = [];
dom2.window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => h3.push(f) } } };
const s3 = dom2.window.document.createElement('script');
s3.textContent = relay;
dom2.window.document.body.appendChild(s3);
const deep = (await new Promise((r) => h3[0]({ type: 'getDesignerSurface' }, {}, r))).domStructure;

const page = deep.roots[0].children[0];
const kids = page.children;

check('three levels of nesting are read', () => {
  eq(deep.roots[0].nodeId, 'ROOT', 'root');
  eq(page.nodeId, 'IntakePage00', 'page');
});
check('all four grandchildren are found', () =>
  eq(kids.map((k) => k.nodeId), ['IntakeFormSlot', 'IntakeBar000', 'TusSlot00000', 'TicketWrap00'], 'grandchildren'));

// The node id is a craft id, close to but NOT the element name.
check('the element name comes from the title, not the node id', () => {
  const byId = Object.fromEntries(kids.map((k) => [k.nodeId, k.name]));
  eq(byId.IntakeBar000, 'IntakeActionBar', 'IntakeBar000');
  eq(byId.TusSlot00000, 'UploaderSlot', 'TusSlot00000');
  eq(byId.IntakeFormSlot, 'IntakeFormSlot', 'IntakeFormSlot');
});

// Taking the whole title would break the DOM locator, which matches
// data-system-name exactly.
const ticket = kids.find((k) => k.nodeId === 'TicketWrap00');
check('a trailing label is split off the name', () => {
  eq(ticket.name, 'TicketTableSlot', 'name');
  eq(ticket.label, 'Upload tickets (diagnostic)', 'label');
});
check('nested parentheses inside the label survive intact', () =>
  eq(ticket.label, 'Upload tickets (diagnostic)', 'label'));

check('prop badges are read from the row', () => {
  eq(ticket.badges, ['visibility'], 'badges');
  eq(kids.find((k) => k.nodeId === 'IntakeFormSlot').badges, [], 'unbadged row');
});

check('counts are read per row', () => {
  eq(kids.find((k) => k.nodeId === 'IntakeFormSlot').childCount, 3, 'IntakeFormSlot');
  eq(ticket.childCount, 5, 'TicketTableSlot');
});

// Four leaves each claim children and render none; the two expanded rows above
// them do not count as incomplete.
check('collapsed rows are tallied, expanded ones are not', () =>
  eq(deep.collapsed, 4, 'collapsed'));
check('the whole tree is counted', () => eq(deep.count, 6, 'count'));
check('selection is read on the expanded tree too', () =>
  eq(deep.roots[0].selected, true, 'root selected'));

/* ── The canvas, which is the real structure source ──────────────────────── */

console.log('\ndesigner canvas (the preferred source)');

const canvasHtml = fs.readFileSync('test/fixtures/designer-canvas.html', 'utf8');
const dom3 = new JSDOM(
  `<!doctype html><body><div id="mfgx-screen-designer-canvas">${canvasHtml}</div></body>`,
  { runScripts: 'dangerously', url: 'https://admin.fuuz.app/system/configuration/applicationDesigner' }
);
const h5 = [];
dom3.window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => h5.push(f) } } };
const s5 = dom3.window.document.createElement('script');
s5.textContent = relay;
dom3.window.document.body.appendChild(s5);
const surf = await new Promise((r) => h5[0]({ type: 'getDesignerSurface' }, {}, r));
const cv = surf.canvasStructure;

check('the canvas is scraped', () => {
  if (!cv) throw new Error('canvasStructure missing');
  eq(cv.count, 4, 'element count');
});

const stack = cv.roots[0];
check('type and name both come from the wrapper', () => {
  eq(stack.type, 'Container', 'type');
  eq(stack.name, 'IntakeFieldStack', 'name');
});

check('children nest under the container', () => {
  eq(stack.children.map((c) => `${c.name}<${c.type}>`),
    ['IntakeTarget<SelectInput>', 'IntakeTitle<TextInput>', 'IntakeSource<TextInput>'], 'children');
});

// The wrapper carries the renderer's positioning; the inner #<name> div carries
// what the author set. Reporting the wrapper's style as the design is wrong.
check('CSS comes from the inner div, not just the wrapper', () => {
  eq(stack.css['flex-direction'], 'column', 'flex-direction');
  eq(stack.css.padding, '8px', 'padding');
  eq(stack.css['justify-content'], 'flex-start', 'justify-content');
});

const title = stack.children.find((c) => c.name === 'IntakeTitle');
check('inputs expose their bound field and label', () => {
  eq(title.dataPath, 'title', 'dataPath');
  eq(title.label, 'Title', 'label');
});

// These are React props leaking into the DOM, and there is no other source for
// `description` outside the design itself.
check('authored props are recovered from attributes', () => {
  eq(title.attrs.formelement, 'AssetIntakeForm', 'formelement');
  eq(title.attrs.field, 'title', 'field');
  eq(title.attrs.element, 'TextInput', 'element');
  if (!/leave blank/.test(title.attrs.description)) {
    throw new Error(`description: got ${JSON.stringify(title.attrs.description)}`);
  }
});

check('stringified props are named as present but unreadable', () => {
  for (const p of ['help', 'validation', 'meta']) {
    if (!title.opaqueProps.includes(p)) {
      throw new Error(`${p} missing from opaqueProps: ${JSON.stringify(title.opaqueProps)}`);
    }
  }
});

// A child's props must never be attributed to its parent.
check('a container does not absorb its children\'s props', () => {
  eq(stack.attrs.field, undefined, 'field leaked to the container');
  eq(stack.dataPath, undefined, 'dataPath leaked to the container');
});

check('the canvas alone is enough to call this the screen designer', () =>
  eq(surf.designer, 'screen', 'designer'));
check('the probe reports the canvas row count', () =>
  eq(surf.probe.canvasRows, 4, 'canvasRows'));

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
