// Hiding Fuuz's own console drawers — of which there are TWO.
//
// Written after a real bug: both drawers render identically (same `Console`
// heading, same "Stick to bottom" footer, same resize handle), so matching on
// "Drag to resize" alone hid whichever came first in the DOM. That turned out to
// be the **data flow log** console — the one showing per-node execution, which
// this extension does not reproduce — while the frontend console it *does*
// replace stayed visible. Exactly backwards.
//
// Markup below is captured from admin.fuuz.app's flow designer (2026-08-17),
// trimmed of SVG path data.
import { JSDOM } from 'jsdom';
import * as fs from 'fs';

const relay = fs.readFileSync('dist/relay.js', 'utf8');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};

/** The shared footer both drawers render — part of why they were confusable. */
const footer = `
  <div class="MuiPaper-root jss127">
    <p class="MuiTypography-root MuiTypography-noWrap">0 Logs</p>
    <span class="jss128"></span>
    <span class="MuiSwitch-root"><span class="MuiButtonBase-root MuiSwitch-switchBase Mui-checked">
      <span class="MuiIconButton-label"><input class="MuiSwitch-input" type="checkbox" checked=""><span class="MuiSwitch-thumb"></span></span>
    </span><span class="MuiSwitch-track"></span></span>
    <p class="MuiTypography-root jss129 MuiTypography-noWrap">Stick to bottom</p>
  </div>`;

/** The data flow log console — alt+2, and the only one with selectedNodesMessage. */
const FLOW_LOG = `
<div class="jss117" id="flow-drawer">
  <div class="MuiPaper-root jss120" title="Drag to resize
Double-click or alt+2 to toggle
" style="touch-action: none;">
    <svg data-prefix="fad" data-icon="ellipsis-stroke-vertical" class="svg-inline--fa"><path d="M0 0"></path></svg>
  </div>
  <div class="jss119" style="width: 400px;"><div class="jss511"><div class="jss126 jss444">
    <div class="MuiPaper-root jss130"><div class="jss131"><h6 class="MuiTypography-root MuiTypography-subtitle1">Console</h6></div>
      <button class="MuiButtonBase-root MuiIconButton-root jss131" type="button" title="Open console in new tab">
        <span class="MuiIconButton-label"><svg data-icon="arrow-up-right-from-square"><path d="M0 0"></path></svg></span>
      </button>
    </div>
    <div class="MuiPaper-root jss132"><div class="jss134"><form><div class="jss140">
      <div class="jss146" data-data-path="defaultLogFilters">
        <input placeholder="Filter" type="text" class="MuiInputBase-input" value="">
        <input aria-hidden="true" tabindex="-1" class="MuiSelect-nativeInput" id="select-log-level" value="error,fatal,info,log,result,warn">
      </div>
      <div class="jss146" data-data-path="selectedNodesMessage"><div class="MuiFormControl-root jss535"></div></div>
    </div></form></div></div>
    <div class="jss162"><div></div></div>
    ${footer}
  </div></div></div>
</div>`;

/** The frontend dev console — alt+3, with the brackets-curly glyph. */
const FRONTEND = `
<div class="jss117" id="frontend-drawer">
  <div class="MuiPaper-root jss120" title="Drag to resize
Double-click or alt+3 to toggle
" style="touch-action: none;">
    <svg data-prefix="fad" data-icon="ellipsis-stroke-vertical" class="svg-inline--fa"><path d="M0 0"></path></svg>
  </div>
  <div class="jss119" style="width: 375px;"><div class="jss597"><div class="jss126">
    <div class="MuiPaper-root jss130"><div class="jss131"><h6 class="MuiTypography-root MuiTypography-subtitle1">Console</h6></div>
      <svg data-prefix="fad" data-icon="brackets-curly" class="svg-inline--fa jss131"><path d="M0 0"></path></svg>
    </div>
    <div class="MuiPaper-root jss132"><div class="jss134"><form><div class="jss140">
      <div class="jss146" data-data-path="defaultLogFilters">
        <input placeholder="Filter" type="text" class="MuiInputBase-input" value="">
        <input aria-hidden="true" tabindex="-1" class="MuiSelect-nativeInput" id="select-log-level" value="debug,error,fatal,info,log,result,trace,warn">
      </div>
    </div></form></div></div>
    <div class="jss162"><div></div></div>
    ${footer}
  </div></div></div>
</div>`;

function boot(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="app">app content</div>${html}</body>`,
    { runScripts: 'dangerously', url: 'https://admin.fuuz.app/system/configuration/applicationDesigner' });
  const { window } = dom;
  const handlers = [];
  window.chrome = {
    runtime: { sendMessage() {}, onMessage: { addListener: (f) => handlers.push(f) } },
    storage: { local: { get: (_k, cb) => cb({}), set() {} } },
  };
  const tag = window.document.createElement('script');
  tag.textContent = relay;
  window.document.body.appendChild(tag);
  const ask = (msg) => new Promise((resolve) => {
    let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    handlers.find((h) => h.length >= 3)(msg, {}, settle);
    setTimeout(() => settle({ timedOut: true }), 1500);
  });
  const shown = (id) => {
    const el = window.document.getElementById(id);
    return !!el && el.style.display !== 'none';
  };
  return { window, ask, shown };
}

console.log('two drawers, told apart');

// Flow log first in the DOM, as it is in the real page — the ordering that made
// the old matcher hide the wrong one.
const both = boot(FLOW_LOG + FRONTEND);

await both.ask({ type: 'hideNativeConsole', hide: true, kind: 'frontend' });
check('hiding the frontend console hides the frontend drawer', !both.shown('frontend-drawer'));
check('and leaves the flow log visible — the whole point', both.shown('flow-drawer'),
  'the flow log console was hidden as collateral');

await both.ask({ type: 'hideNativeConsole', hide: true, kind: 'flowLog' });
check('the flow log can be hidden on its own request', !both.shown('flow-drawer'));

await both.ask({ type: 'hideNativeConsole', hide: false, kind: 'flowLog' });
check('un-hiding the flow log restores it', both.shown('flow-drawer'));
check('without also restoring the frontend one', !both.shown('frontend-drawer'),
  'un-hiding one drawer cleared the other');

await both.ask({ type: 'hideNativeConsole', hide: false, kind: 'frontend' });
check('both can be visible at once', both.shown('flow-drawer') && both.shown('frontend-drawer'));

// The single-switch callers predate there being two consoles, and always meant
// the frontend one.
const legacy = boot(FLOW_LOG + FRONTEND);
await legacy.ask({ type: 'hideNativeConsole', hide: true });
check('a request with no kind means the frontend console',
  !legacy.shown('frontend-drawer') && legacy.shown('flow-drawer'));

console.log('\nfallback when the shortcut hint changes');

// Same drawers with the alt+N hints stripped: classification must fall back to
// what each console uniquely renders.
const noHints = boot(
  (FLOW_LOG + FRONTEND).replace(/Double-click or alt\+\d to toggle\n/g, '')
);
await noHints.ask({ type: 'hideNativeConsole', hide: true, kind: 'frontend' });
check('brackets-curly identifies the frontend console', !noHints.shown('frontend-drawer'));
check('selectedNodesMessage keeps the flow log safe', noHints.shown('flow-drawer'));

console.log('\nsafety');

// Hiding the wrong node is how this broke the whole app once before.
const appOnly = boot('');
const miss = await appOnly.ask({ type: 'hideNativeConsole', hide: true, kind: 'frontend' });
check('no drawer present is reported, not faked', miss.found === false, JSON.stringify(miss));
check('and the app is left alone',
  appOnly.window.document.getElementById('app').style.display !== 'none');

// An unclassifiable drawer must be skipped: hiding the wrong one is worse.
const unknown = boot(`
<div class="jss117" id="mystery-drawer">
  <div class="MuiPaper-root" title="Drag to resize"></div>
  <div class="jss119"><div><h6>Console</h6>${footer}</div></div>
</div>`);
await unknown.ask({ type: 'hideNativeConsole', hide: true, kind: 'frontend' });
check('a drawer that cannot be classified is left visible', unknown.shown('mystery-drawer'),
  'an unidentified drawer was hidden anyway');

console.log('\ncontext: the flow switch is only offered where the drawer exists');

// The frontend console is on every Fuuz screen; the flow log only on a data flow
// tab. Reporting presence lets the panel offer one switch and not the other,
// rather than showing a control that would do nothing.
const onFlowTab = boot(FLOW_LOG + FRONTEND);
const flowSurface = await onFlowTab.ask({ type: 'getDesignerSurface' });
check('both drawers are reported on a flow tab',
  flowSurface.consoles?.flowLog === true && flowSurface.consoles?.frontend === true,
  JSON.stringify(flowSurface.consoles));

const onScreen = boot(FRONTEND);
const screenSurface = await onScreen.ask({ type: 'getDesignerSurface' });
check('a screen with only the frontend console reports just that',
  screenSurface.consoles?.frontend === true && screenSurface.consoles?.flowLog === false,
  JSON.stringify(screenSurface.consoles));

const noConsoles = boot('');
const bare = await noConsoles.ask({ type: 'getDesignerSurface' });
check('a page with neither reports neither',
  bare.consoles?.flowLog === false && bare.consoles?.frontend === false,
  JSON.stringify(bare.consoles));

console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
