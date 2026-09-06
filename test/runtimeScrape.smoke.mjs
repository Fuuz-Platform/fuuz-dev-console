// A running screen's elements, read from its rendered DOM.
//
// Highlighting worked in the designer and not at runtime, and the deeper reason was not
// the locator: at runtime there was no element list to hover in the first place. Every
// name this produces came out of the page, so the locator can always find it again —
// highlighting works by construction rather than by a lookup that might miss.
//
// Runs against the built relay, so it exercises the code path the extension does.
import { JSDOM } from 'jsdom';
import * as fs from 'fs';

const relay = fs.readFileSync('dist/relay.js', 'utf8');
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) fail++;
};

/** Load a rendered screen — no designer canvas, which is what a run route looks like. */
function runScreen(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    runScripts: 'dangerously',
    url: 'https://build.mfgx.fuuz.app/screens/abc/run',
  });
  const { window } = dom;
  /*
   * jsdom performs no layout, so every `getBoundingClientRect` is zeroes — and the
   * highlighter deliberately refuses a zero-size element, because outlining one draws a
   * box of nothing. Giving the window a plausible layout keeps that guard intact (it is
   * correct in a browser) while letting the wiring under test actually run.
   */
  window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 20, y: 30, left: 20, top: 30, width: 200, height: 40, right: 220, bottom: 70, toJSON() { return {}; } };
  };
  const handlers = [];
  window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => handlers.push(f) } } };
  const s = window.document.createElement('script');
  s.textContent = relay;
  window.document.body.appendChild(s);
  return {
    call: (msg) => new Promise((r) => handlers[0](msg, {}, r)),
    window,
  };
}

console.log('a running screen yields an element tree');

const SCREEN = `
  <div id="IntakePage" element="Container">
    <div id="Card1" element="Card">
      <div formelement="IntakeForm" field="title" element="TextInput" data-label="Title"></div>
      <div formelement="IntakeForm" field="notes" element="TextInput"></div>
    </div>
  </div>`;

{
  const { call } = runScreen(SCREEN);
  const reply = await call({ type: 'getDesignerSurface' });

  check('a run route is recognised as a screen', reply?.designer === 'screen', `designer=${reply?.designer}`);
  const scrape = reply?.runtimeStructure;
  check('the runtime scrape ran', !!scrape, 'no runtimeStructure in the reply');
  check('every element was found', scrape?.count === 4, `count=${scrape?.count}`);
  check('the tree is nested by containment',
    scrape?.roots?.[0]?.name === 'IntakePage'
    && scrape.roots[0].children?.[0]?.name === 'Card1'
    && scrape.roots[0].children[0].children?.length === 2,
    JSON.stringify(scrape?.roots?.map((r) => r.name)));
  check('the marker attributes used are reported',
    Array.isArray(scrape?.probe?.attributes) && scrape.probe.attributes.includes('formelement'),
    JSON.stringify(scrape?.probe));
}

console.log('\nand every name it produces can be highlighted');

// The point of the whole exercise: the names are locatable because they came from here.
for (const name of ['IntakePage', 'Card1', 'IntakeForm']) {
  const { call, window } = runScreen(SCREEN);
  const reply = await call({ type: 'highlight', target: { name } });
  check(`${name} highlights`, reply?.found === true, `via=${reply?.via} found=${reply?.found}`);
  check(`${name} paints an overlay`,
    !!window.document.getElementById('__fuuz_devtool_overlay'),
    'no overlay element in the document');
}

// A label goes on the outline, which is what makes it readable on a busy screen.
{
  const { call, window } = runScreen(SCREEN);
  await call({ type: 'highlight', target: { name: 'IntakeForm', type: 'TextInput' } });
  const box = window.document.getElementById('__fuuz_devtool_overlay');
  check('the outline carries a label tag', (box?.textContent ?? '').includes('IntakeForm'),
    `text=${box?.textContent}`);
  check('the outline is a solid darker violet, distinct from the platform’s own',
    (box?.style?.outline ?? '').includes('solid') && (box?.style?.outline ?? '').includes('3A18B8'),
    `outline=${box?.style?.outline}`);
  check('and sits below the console in z-order',
    Number(box?.style?.zIndex) < 2147483646, `z=${box?.style?.zIndex}`);
}

console.log('\nthe module navigator is never mistaken for a screen');

// The Application Designer's left nav is also a MUI TreeView, and it was being scraped
// as though its rows were screen elements — every one of which failed to highlight.
{
  const nav = `
    <ul role="tree">
      <li role="treeitem"><div class="MuiTreeItem-label"><div title="module-group-materialsManagement"></div></div></li>
      <li role="treeitem"><div class="MuiTreeItem-label"><div title="DataModel-Product"></div></div></li>
      <li role="treeitem"><div class="MuiTreeItem-label"><div title="module-engineering"></div></div></li>
    </ul>`;
  const { call } = runScreen(nav);
  const reply = await call({ type: 'getDesignerSurface' });
  check('navigator rows are not reported as screen structure',
    !reply?.domStructure || reply.domStructure.count === 0,
    `count=${reply?.domStructure?.count} names=${JSON.stringify(reply?.domStructure?.roots?.map((r) => r.name))}`);
}


console.log('\na flow node highlights on the canvas, the same way');

/*
 * The flow canvas, as the designer renders it: nodes carrying `data-nodeid` with their
 * title as a heading. Highlighting one has to use the *same* overlay a screen element
 * does — one implementation, so the two cannot drift apart.
 */
{
  const canvas = `
    <div id="flow123-mfgx-data-flow-diagram">
      <div data-nodeid="n1"><h4>Fetch Assets</h4></div>
      <div data-nodeid="n2"><h4>For Each   Library</h4></div>
    </div>`;

  // By id, which is exact — the definition and the canvas agree on it even when the
  // canvas wraps or truncates the displayed title.
  {
    const { call, window } = runScreen(canvas);
    const reply = await call({ type: 'highlight', target: { nodeId: 'n2', name: 'For Each Library' } });
    check('a node highlights by its diagram id', reply?.found === true, `via=${reply?.via}`);
    check('and the id is what matched', (reply?.via ?? '').includes('data-nodeid'), `via=${reply?.via}`);
    /*
     * A node is styled **in place**, not covered by a box.
     *
     * A rectangular overlay sits slightly wrong around a rounded node and cannot follow the
     * canvas's own zoom or pan at all — and the earlier attempt to grow the outline to a
     * container walked four levels up and outlined most of the page, because a flow canvas has
     * no screen-element markers to stop the climb.
     */
    const node = window.document.querySelector('[data-nodeid="n2"]');
    check('the node itself carries the outline', (node?.style?.outline ?? '').includes('solid'),
      `outline=${node?.style?.outline}`);
    // Deliberately brighter and thicker than the screen-element outline: a thin line is lost on a
    // canvas of colourful cards, and it must not be mistaken for either wire colour.
    check('in the pronounced selection violet',
      (node?.style?.outline ?? '').includes('6D3BFF') && (node?.style?.outline ?? '').includes('3px'),
      `outline=${node?.style?.outline}`);
    check('with a wash over the node, not just a border',
      (node?.style?.boxShadow ?? '').includes('inset'), `shadow=${node?.style?.boxShadow}`);
    check('and no page-sized overlay box is painted',
      !window.document.getElementById('__fuuz_devtool_overlay'), 'an overlay box was created');
  }

  // With no id, the title still finds it — and the canvas's own whitespace must not stop
  // a node the developer can plainly see from highlighting.
  {
    const { call, window } = runScreen(canvas);
    const reply = await call({ type: 'highlight', target: { name: 'Fetch Assets' } });
    check('a node highlights by its title', reply?.found === true, `via=${reply?.via}`);
    // Clearing must put the node's own style back exactly — the canvas sets these itself, so
    // leaving ours behind would look like a selection that cannot be cleared.
    await call({ type: 'clearHighlight' });
    const node = window.document.querySelector('[data-nodeid="n1"]');
    check('clearing restores the node’s own style', !node?.style?.outline, `outline=${node?.style?.outline}`);
  }
  {
    const { call } = runScreen(canvas);
    const reply = await call({ type: 'highlight', target: { name: 'For Each Library' } });
    check('collapsed whitespace in the canvas title still matches',
      reply?.found === true, `via=${reply?.via}`);
  }

  // Equality, not substring: `Fetch` must not silently outline `Fetch Assets`.
  {
    const { call } = runScreen(canvas);
    const reply = await call({ type: 'highlight', target: { name: 'Fetch' } });
    check('a partial title does not match the wrong node', reply?.found !== true, `via=${reply?.via}`);
  }
}

console.log('\nthe visible tab is read, not the first one mounted');

/*
 * The real bug, reproduced: the Application Designer keeps every open tab **mounted** and
 * hides the inactive ones. With a screen tab open alongside a flow, the fixed-order canvas
 * lookup reported `screen` while the developer was looking at the flow — so the panel
 * fetched a screen design, never asked the flow engine for events, and the flow simply
 * could not be read.
 *
 * jsdom performs no layout, so visibility is expressed the way the browser reports it:
 * `offsetParent` is null inside a `display: none` subtree, and a hidden element has no
 * client rects.
 */
function designerWithTabs(activeKind) {
  const dom = new JSDOM(`<!doctype html><body>
      <div id="hiddenPanel"><div id="mfgx-screen-designer-canvas"></div></div>
      <div id="visiblePanel"><div id="flowABC-mfgx-data-flow-diagram">
        <div data-nodeid="n1"><h4>Fetch Assets</h4></div>
      </div></div>
      <button data-tab-id="tScreen"><p>Asset Intake</p><svg data-icon="desktop"></svg></button>
      <button data-tab-id="flowABC"><p>Sync Bunny Assets</p><svg data-icon="diagram-project"></svg></button>
    </body>`, {
    runScripts: 'dangerously',
    url: 'https://admin.fuuz.app/system/configuration/applicationDesigner',
  });
  const { window } = dom;
  const hiddenIds = activeKind === 'flow'
    ? ['mfgx-screen-designer-canvas']
    : ['flowABC-mfgx-data-flow-diagram'];

  window.Element.prototype.getBoundingClientRect = function rect() {
    const hidden = hiddenIds.includes(this.id) || hiddenIds.some((id) => this.querySelector?.(`#${id}`));
    return hidden
      ? { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, toJSON() { return {}; } }
      : { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, toJSON() { return {}; } };
  };
  window.Element.prototype.getClientRects = function rects() {
    const hidden = hiddenIds.includes(this.id);
    return hidden ? [] : [this.getBoundingClientRect()];
  };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return hiddenIds.includes(this.id) ? null : window.document.body; },
  });

  const handlers = [];
  window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => handlers.push(f) } } };
  const script = window.document.createElement('script');
  script.textContent = relay;
  window.document.body.appendChild(script);
  return { call: (msg) => new Promise((r) => handlers[0](msg, {}, r)) };
}

{
  const { call } = designerWithTabs('flow');
  const reply = await call({ type: 'getDesignerSurface' });
  check('a visible flow beats a mounted-but-hidden screen',
    reply?.designer === 'flow', `designer=${reply?.designer}`);
  check('and its own id comes with it', reply?.designerId === 'flowABC', `designerId=${reply?.designerId}`);
  check('the active tab is the flow’s, not the screen’s',
    reply?.tabName === 'Sync Bunny Assets', `tabName=${reply?.tabName}`);
  check('both canvases are reported, so the choice is auditable',
    (reply?.probe?.canvases ?? []).length === 2, JSON.stringify(reply?.probe?.canvases));
  check('the flow canvas’s nodes are read', (reply?.canvasNodes?.nodes ?? []).length === 1,
    JSON.stringify(reply?.canvasNodes?.nodes));
}

// And the converse, so the fix is not just "always prefer flow".
{
  const { call } = designerWithTabs('screen');
  const reply = await call({ type: 'getDesignerSurface' });
  check('a visible screen beats a mounted-but-hidden flow',
    reply?.designer === 'screen', `designer=${reply?.designer}`);
  check('with the screen tab active', reply?.tabName === 'Asset Intake', `tabName=${reply?.tabName}`);
}

console.log('\nwhat is not a screen element stays out of the list');

/*
 * All three of these came off a live run route and each produced a bogus element:
 *
 *   field="[object Object]"          the runtime interpolates objects into attributes
 *   data-data-path="assetCollection" a *binding*, which then parented the real element
 *   defaultLogFilters                Fuuz's own console drawer, which we open ourselves
 *                                    by enabling transform debugging
 */
{
  const messy = `
    <div id="root">
      <div data-data-path="assetCollection">
        <div formelement="AssetIntakeForm" field="title" element="TextInput"></div>
      </div>
      <div field="[object Object]"></div>
      <div class="MuiDrawer-root">
        <h6>Console</h6>
        <div data-data-path="selectedNodesMessage"></div>
        <div data-data-path="defaultLogFilters"><div field="[object Object]"></div></div>
      </div>
    </div>`;
  const { call } = runScreen(messy);
  const reply = await call({ type: 'getDesignerSurface' });
  const names = (reply?.runtimeStructure?.roots ?? []).flatMap(function flat(n) {
    return [n.name, ...(n.children ?? []).flatMap(flat)];
  });

  check('a stringified object is never a name', !names.includes('[object Object]'), JSON.stringify(names));
  check('a bound path is not an element', !names.includes('assetCollection'), JSON.stringify(names));
  check('the platform’s own log filters are not screen elements',
    !names.includes('defaultLogFilters'), JSON.stringify(names));
  check('the real element survives', names.includes('AssetIntakeForm'), JSON.stringify(names));

  // The binding used to parent the element it bound — the tree inverted.
  const form = (reply?.runtimeStructure?.roots ?? []).find((n) => n.name === 'AssetIntakeForm');
  check('the element is a root, not a child of its own binding', !!form,
    JSON.stringify(reply?.runtimeStructure?.roots?.map((r) => r.name)));
  // The pair (name, path) is what tells two fields on one form apart.
  check('and it keeps its bound path', form?.dataPath === 'title', `dataPath=${form?.dataPath}`);
}

// The path can sit on a wrapper rather than the control, and must not be lost.
{
  const { call } = runScreen('<div data-data-path="sourceUrl"><div formelement="F" element="TextInput"></div></div>');
  const reply = await call({ type: 'getDesignerSurface' });
  check('a path on the wrapper is attributed to the element inside it',
    reply?.runtimeStructure?.roots?.[0]?.dataPath === 'sourceUrl',
    JSON.stringify(reply?.runtimeStructure?.roots));
}

console.log('\nnothing of ours is left on the canvas after clearing');

/*
 * jsdom implements no SVG geometry, so the wire *classification* is covered by unit tests against
 * `wires.ts` instead. What is worth asserting through the real relay is the part unit tests cannot
 * see: that clearing removes every trace, including from elements our own record might have lost
 * track of when the canvas re-rendered.
 */
{
  const canvas = `
    <div id="flow1-mfgx-data-flow-diagram">
      <div data-nodeid="Target"><div id="mfgx-node-Target"></div></div>
      <svg>
        <g data-linkid="stale">
          <path data-fuuz-wire="1" style="stroke: rgb(34,211,238); stroke-width: 4; opacity: 1;" d="M0,0 L 10,10"></path>
          <circle data-fuuz-wire="1" style="fill: rgb(245,158,11);" cx="5" cy="5" r="5"></circle>
        </g>
      </svg>
    </div>`;
  const { call, window } = runScreen(canvas);
  await call({ type: 'clearHighlight' });

  const doc = window.document;
  const swept = Array.from(doc.querySelectorAll('path, circle'));
  check('a marked wire is stripped even without a live record',
    swept.every((el) => !el.style.stroke && !el.style.fill && !el.style.strokeWidth),
    swept.map((el) => el.getAttribute('style')).join(' | '));
  check('and the marker itself is removed',
    !doc.querySelector('[data-fuuz-wire]'), 'a marker survived the sweep');
}

console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
