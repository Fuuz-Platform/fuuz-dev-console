// Can a developer actually get to every feature?
//
// Written after finding that the whole property inspector — inline editing, the
// `fn` calls, transform preview — had no tab. Its only entry point was a button
// on an element row, so whenever the element tree was empty (which is exactly
// when you most want it) every editing feature was invisible while all 188 unit
// tests passed.
//
// Unit tests prove a feature works. This proves you can reach it.
import * as fs from 'fs';

const panel = fs.readFileSync('dist/panel.js', 'utf8');
const worker = fs.readFileSync('dist/background.js', 'utf8');
const relay = fs.readFileSync('dist/relay.js', 'utf8');
const source = fs.readFileSync('src/panel/index.tsx', 'utf8');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};

console.log('every mode has a way in');

// A mode rendered by the panel but never set by a clickable control is dead UI.
const modes = [...new Set([...source.matchAll(/mode === '([a-z]+)'/g)].map((m) => m[1]))];
const entries = new Set([...source.matchAll(/onClick=\{\(\) => \{?\s*(?:[^}]*?)setMode\('([a-z]+)'\)/g)].map((m) => m[1]));

for (const mode of modes) {
  check(`${mode} is reachable by a click`, entries.has(mode),
    `no onClick sets mode '${mode}' — it can only be reached from another pane, or not at all`);
}

console.log('\nproperties, transforms and CSS live inside the element tree');

// They used to be their own tabs, which made the developer the join between
// them. Each must now be a section of the element's own detail.
const detail = fs.readFileSync('src/panel/ElementDetail.tsx', 'utf8');
for (const section of ['State', 'Transforms', 'Properties', 'CSS']) {
  check(`${section} is a section of the element detail`,
    new RegExp(`title="${section}"`).test(detail), `no <Section title="${section}">`);
}
check('the detail is rendered from the element tree',
  /<ElementDetail/.test(fs.readFileSync('src/panel/ElementsPane.tsx', 'utf8')),
  'ElementsPane does not render ElementDetail');

// Dead panes are worse than missing ones: they carry code that looks live.
// The scratchpad and the design lint pane were removed: the first never did what was
// wanted, the second was permanently empty because it depends on a design fetch that
// rarely lands. An empty tab is a worse answer than no tab — it implies nothing is
// wrong when nothing was checked.
for (const gone of ['PropertyInspector.tsx', 'CssPane.tsx', 'ScratchpadPane.tsx', 'DesignPane.tsx']) {
  check(`${gone} is removed rather than orphaned`, !fs.existsSync(`src/panel/${gone}`),
    'the file is still present but nothing renders it');
}

console.log('\nthe shipped bundle carries every feature');

// Cheap smoke over the built artefact: a feature that never made it into the
// bundle cannot be used no matter how the UI is wired.
for (const [feature, needle] of [
  ['property inspector', 'Undocumented for this element type'],
  ['inline editing', 'Expected true or false'],
  ['fn calls', 'callElementFn'],
  ['transform preview', 'Evaluate on server'],
  ['per-element CSS editing', 'style'],
  // Markers must be ASCII: esbuild escapes non-ASCII to \uXXXX when minifying,
  // so an em dash in the needle never matches the bundle it is checking.
  // The two consoles that replaced the scratchpad. Both must be in the bundle on
  // every surface, since neither depends on a capture.
  ['script console', 'sandboxed frame'],
  ['script sandbox', 'fuuz-script-sandbox'],
  // The GraphQL console and the table view are built and bundled, but their tab is
  // hidden while API access is off — the code must still be present so re-enabling is a
  // one-line change rather than a rebuild of the feature.
  ['graphql console', 'Variables must be a JSON object'],
  ['table view', 'copy TSV'],
  ['api access switched off', 'API access is switched off'],
  ['open and save', 'fuuz-dev-console'],
  ['model browser', 'Click a model on the canvas'],
  ['subscription triage', 'resubscribing in a loop'],
  ['design lint folded into issues', 'designFindings'],
  // The Screen tab is the element tree plus a persistent detail pane. It no longer
  // repeats the state tree — that was the same StateNodes the Split and State panes
  // already render — so the marker is the pane that replaced it.
  ['element detail pane', 'Pick an element'],
  ['clickable path trees', 'Insert '],
  ['runtime element scrape', 'only what is currently rendered'],
  ['function palette', 'hover one to dim the values it cannot take'],
  // The Fuuz library is most of what a real transform uses, and none of it runs locally — so the
  // refusal has to be bundled, or pressing Run gives a bare "unknown function".
  ['fuuz function catalogue', 'they run on the platform, not in this panel'],
  ['page-context services', 'pageQuery'],
  ['path search', 'Find a key or a value'],
  ['property provenance', 'A literal value set in the designer'],
  ['bulk style by type', 'only the fields you fill in are applied'],
  // The filter is driven by hover; shift-click only pins it. It was shift-click *only*, which is a
  // hidden modifier — the feature read as broken because selecting a function appeared to do nothing.
  ['reverse-context filter', 'shift-click to keep this filter on'],
  ['explicit window preference', 'Prefer a separate window'],
  ['runtime element list from $components', 'more from $components'],
  ['production gate', 'looks like a production environment'],
  ['element/state merge', 'no state'],
  ['screenshot', 'captureTab'],
  ['structure diagnostics', 'Design fetch attempted'],
]) {
  check(`${feature} is in the bundle`, panel.includes(needle), `missing marker: ${needle}`);
}

/*
 * The placement preference lives in the worker, not the panel.
 *
 * Checked because it is easy to break invisibly: the toolbar reading the wrong key meant every
 * click opened a window, and nothing failed — it just quietly stopped honouring the dock.
 */
console.log('\nthe console reopens where it was last put');
check('the worker reads the chosen placement', worker.includes('lastDock'),
  'no lastDock in dist/background.js');

/*
 * Wire colouring reads the diagram model rather than measuring the canvas.
 *
 * Checked because the fallback is silent by design: if the model reader stopped being bundled, the
 * geometry path would still colour *something*, just too much of it — which is the bug it replaced.
 */
check('the relay prefers the link model', relay.includes('link model') && relay.includes('flowLinks'),
  'no link-model path in dist/relay.js');
// Closing is not a preference; only asking for a window is.
check('closing does not record a window preference',
  !/mode === 'off'\)\s*void preferWindow/.test(worker),
  'closing the in-page console still sets the window preference');

console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
