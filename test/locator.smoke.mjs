// Locator precision, against the designer canvas markup as the platform emits it.
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
const relay = fs.readFileSync('dist/relay.js', 'utf8');
const dom = new JSDOM(`<!doctype html><body>
<div id="mfgx-screen-designer-canvas">
  <div data-screen-element="Screen" data-system-name="Screen">
    <div data-screen-element="Container" data-system-name="IntakePage"><div id="IntakePage">
      <div data-screen-element="Container" data-system-name="IntakeFormSlot"><div id="IntakeFormSlot">
        <div data-screen-element="SelectInput" data-system-name="IntakeTarget">
          <div data-label="Library / Collection" data-data-path="assetCollection"></div></div>
        <div data-screen-element="TextInput" data-system-name="IntakeTitle">
          <div data-label="Title" data-data-path="title" formelement="AssetIntakeForm" element="TextInput"></div></div>
      </div></div>
      <div data-screen-element="EmbeddedWebpage" data-system-name="TusUploader"></div>
    </div></div>
  </div>
</div>
<button data-tab-id="cmsvt7hww002k3b6xvit7djw0" class="jss466"><p>Asset Intake</p></button>
</body>`, { runScripts: 'dangerously', url: 'https://admin.fuuz.app/system/configuration/applicationDesigner' });
const { window } = dom;
const h = [];
window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => h.push(f) } } };
const s = window.document.createElement('script'); s.textContent = relay; window.document.body.appendChild(s);
const call = (msg) => new Promise(r => h[0](msg, {}, r));

let fail = 0;
const check = (l, c) => { try { c(); console.log('  ✓ ' + l); } catch (e) { fail++; console.error('  ✗ ' + l + '\n      ' + e.message); } };

// Highlighting proves the locator found the right node.
for (const [name, type] of [
  ['TusUploader', 'EmbeddedWebpage', 'TusUploader'],
  ['IntakeTarget', 'SelectInput', 'IntakeTarget'],
  ['IntakeFormSlot', 'Container', 'IntakeFormSlot'],
  ['Screen', 'Screen', 'Screen'],
]) {
  // `getElementStyles` reports purely on locating the node; `highlight` also
  // needs a non-zero box, which jsdom has no layout to provide.
  const r = await call({ type: 'getElementStyles', target: { name, type } });
  check(`locates ${name} exactly`, () => {
    if (!r.found) throw new Error('not found — the locator missed it');
  });
}

const miss = await call({ type: 'getElementStyles', target: { name: 'NoSuchElement', type: 'Ghost' } });
check('reports a miss for an element that is not there', () => { if (miss.found) throw new Error('claimed a hit'); });

const surface = await call({ type: 'getDesignerSurface' });
check('detects the screen designer and its active tab', () => {
  if (surface.designer !== 'screen') throw new Error('designer not detected');
  if (surface.tabId !== 'cmsvt7hww002k3b6xvit7djw0') throw new Error('tab id wrong: ' + surface.tabId);
  if (surface.tabName !== 'Asset Intake') throw new Error('tab name wrong: ' + surface.tabName);
});


// The flow canvas carries the flow id as a prefix — verify the suffix match and
// that the id is recovered.
{
  const d2 = new JSDOM(`<!doctype html><body>
    <div id="cmsw8uzig00lf3b6ypl9bwk21-mfgx-data-flow-diagram">
      <div class="node" data-nodeid="source"><div id="mfgx-node-source"><p>Request</p></div></div>
      <div class="node" data-nodeid="getLibraries"><div id="mfgx-node-getLibraries"><p>Get Bunny Libraries</p></div></div>
    </div></body>`, { runScripts: 'dangerously', url: 'https://admin.fuuz.app/system/configuration/applicationDesigner' });
  const hh = [];
  d2.window.chrome = { runtime: { sendMessage() {}, onMessage: { addListener: (f) => hh.push(f) } } };
  const s2 = d2.window.document.createElement('script'); s2.textContent = relay; d2.window.document.body.appendChild(s2);
  const surf = await new Promise(r => hh[0]({ type: 'getDesignerSurface' }, {}, r));
  check('detects the flow designer and recovers the flow id', () => {
    if (surf.designer !== 'flow') throw new Error('kind: ' + surf.designer);
    if (surf.designerId !== 'cmsw8uzig00lf3b6ypl9bwk21') throw new Error('id: ' + surf.designerId);
    if (surf.nodes !== 2) throw new Error('nodes: ' + surf.nodes);
  });
}

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);
