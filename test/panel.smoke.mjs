// Headless smoke test for the Fuuz Dev Console. Loads the real built
// media/screenrunner/screenrunner.js into jsdom, feeds it a payload shaped like
// a live capture, and asserts the two panes render and that the trace linking
// works in both directions — the part that makes this more than a console.
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';

const dir = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(dir, '..', 'dist', 'panel.js'), 'utf8');
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`, {
  runScripts: 'dangerously', pretendToBeVisual: true,
});
const { window } = dom;
const posted = [];
let sse = null;
window.EventSource = class {
  constructor() { sse = this; this.onmessage = null; this.onerror = null; this.onopen = null; }
  close() {}
};
window.fetch = (url, init) => { posted.push(JSON.parse(init.body)); return Promise.resolve({ ok: true }); };
const deliver = (payload) => sse && sse.onmessage && sse.onmessage({ data: JSON.stringify(payload) });

const entry = (seq, kind, title, write, after, extra = {}) => ({
  id: `e${seq}`, seq, ts: `10:24:3${seq}.000`, epoch: seq, kind, title,
  dur: '2ms', write, reads: [], after, level: kind === 'error' ? 'error' : 'log', payload: [title, extra],
});

const entries = [
  entry(1, 'query', 'Query · ticket.findMany', 'components.TicketTable.data', '[ 12 items ]', { rows: 12, took: 118 }),
  { ...entry(2, 'debug', 'Transform Debugging · url', 'components.AssetPlayer.url', '"data:text/html;base64,PCFk…"', {
    expression: '"data:text/html;base64," & $doc',
  }), elementType: 'EmbeddedWebpage', cacheKey: 'playerUrl', remote: true, attribution: 'cacheKey' },
  entry(3, 'error', 'Transform Error · executeFlow', 'variables.uploadState', '"Gateway Timeout"', {
    error: { name: 'HttpError', jse_shortmsg: 'Gateway Timeout', code: 504 },
  }),
];

const leaf = (id, label, type, value, vk, trace) => ({ id, label, type, value, vk, trace, changed: true });
const PAYLOAD = {
  status: 'attached',
  statusDetail: 'Attached to Asset Intake',
  target: { title: 'Asset Intake', url: 'https://build.mfgx.fuuz.app/app/wms/AssetIntake' },
  screenName: 'AssetIntake',
  snapshotAt: '10:24:33.000',
  dropped: 0,
  design: {
    screenName: 'Asset Intake', version: '0.0.7',
    coverage: {
      total: 3, exercised: 2,
      unexercised: [{ elementName: 'IntakeSubmit', elementType: 'FlowButton', property: 'payload', remote: false }],
    },
  },
  entries,
  tree: [{
    id: '__screen__', label: 'Screen', type: 'AssetIntake', vk: 'obj', trace: [], changed: false,
    children: [
      {
        id: 'components', label: 'components', type: '2 keys', vk: 'obj', trace: [], changed: true,
        children: [
          {
            id: 'components.IntakePrepare', label: 'IntakePrepare', type: '1 key', vk: 'obj', trace: [], changed: true,
            children: [leaf('components.IntakePrepare.url', 'url', 'string', '"data:text/html;base64,PCFk…"', 'str', ['e1', 'e2'])],
          },
          {
            id: 'components.TicketTable', label: 'TicketTable', type: '1 key', vk: 'obj', trace: [], changed: true,
            children: [leaf('components.TicketTable.data', 'data', 'array', '[ 12 items ]', 'num', ['e1'])],
          },
        ],
      },
      {
        id: 'variables', label: 'variables', type: '1 key', vk: 'obj', trace: [], changed: true,
        children: [leaf('variables.uploadState', 'uploadState', 'string', '"Gateway Timeout"', 'err', ['e3'])],
      },
    ],
  }],
};

let failures = 0;
const check = (label, fn) => { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { failures++; console.error(`  ✗ ${label}\n      ${e.message}`); } };
const $ = (sel) => [...window.document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const text = () => window.document.body.textContent;

async function main() {
  const s = window.document.createElement('script');
  s.textContent = code;
  window.document.body.appendChild(s);
  await tick();
  check('subscribes to the payload stream', () => assert.ok(sse, 'EventSource never opened'));

  deliver(PAYLOAD);
  await tick();

  check('renders both panes with the screen and status', () => {
    assert.ok(text().includes('AssetIntake'), 'screen name missing');
    assert.ok(text().includes('Execution log'), 'log pane missing');
    assert.ok(text().includes('Current state'), 'state pane missing');
    assert.ok(text().includes('3 logs'), `log count wrong: ${text().slice(0, 200)}`);
  });

  check('classifies entries into badges', () => {
    assert.equal($('.badge.query').length, 1, 'query badge');
    assert.equal($('.badge.debug').length, 1, 'transform badge');
    assert.equal($('.badge.error').length, 1, 'error badge');
  });

  check('an error entry is expanded by default and shows the platform error', () => {
    assert.ok(text().includes('jse_shortmsg'), 'error body not expanded');
    assert.ok(text().includes('Gateway Timeout'), 'error text missing');
  });

  check('the design join surfaces element type, remote flag and coverage', () => {
    const t = text();
    assert.ok(t.includes('EmbeddedWebpage'), 'element type badge missing');
    assert.ok(t.includes('remote'), 'remote badge missing');
    assert.ok(t.includes('2/3 dynamic props evaluated'), `coverage missing: ${t.match(/\d+\/\d+ dynamic props/)}`);
    assert.ok(t.includes('1 never ran'), 'unexercised count missing');
    const never = [...window.document.querySelectorAll('.never')][0];
    assert.ok(never && never.title.includes('IntakeSubmit.payload'), 'unexercised detail missing from tooltip');
  });

  check('the state tree shows the ⌁ trace count', () => {
    const chips = $('.tracechip').map(c => c.textContent.trim());
    assert.ok(chips.includes('⌁ 2'), `expected a 2-write trace, got ${JSON.stringify(chips)}`);
  });

  const revealChip = $('.writechip').find(c => c.textContent.includes('components.TicketTable.data'));
  check('the write chip is rendered on the entry that wrote state', () => assert.ok(revealChip, 'write chip missing'));
  click(revealChip);
  await tick();
  check('log → state: the write chip reveals and selects the node', () => {
    const sel = $('.treerow.sel');
    assert.equal(sel.length, 1, 'nothing selected');
    assert.ok(sel[0].textContent.includes('data'), 'wrong node selected');
  });

  check('state → log: ⌁ filters the log to the writes behind the value', async () => {
    const chip = $('.tracechip').find(c => c.textContent.trim() === '⌁ 2');
    click(chip);
  });
  await tick();

  check('tracing shows the banner, the filtered count and a numbered timeline', () => {
    assert.ok(text().includes('TRACING'), 'trace banner missing');
    assert.ok(text().includes('2 of 3 logs'), `filter count wrong: ${text().match(/\d+ of \d+ logs/)}`);
    assert.ok(text().includes('2 writes produced this value'), 'trace summary missing');
    assert.equal($('.step').length, 2, 'timeline steps missing');
    // The timeline is the before → after story, not just a list of entries.
    assert.ok(text().includes('undefined →'), 'before → after missing');
  });

  check('the log pane is filtered to exactly the trace entries', () => {
    const titles = $('.entry .title').map(t => t.textContent);
    assert.equal(titles.length, 2, `expected 2 entries, got ${JSON.stringify(titles)}`);
    assert.ok(titles.some(t => t.includes('ticket.findMany')), 'query entry missing');
    assert.ok(!titles.some(t => t.includes('Transform Error')), 'unrelated entry leaked into the trace');
  });

  check('"Show all logs" leaves tracing', () => {
    const back = $('button').find(b => b.textContent.includes('Show all logs'));
    assert.ok(back, 'exit-trace button missing');
    click(back);
  });
  await tick();
  check('all entries are back', () => assert.equal($('.entry .title').length, 3));

  // State no longer has a tab of its own — the Screen tab supersedes it, showing
  // each element with its own state rather than a separate tree. Split is where
  // the state renderer still lives, as its right half.
  check('the Screen tab replaces the standalone State tab', () => {
    assert.equal($('button').filter(b => b.textContent === 'State').length, 0,
      'a standalone State tab is still rendered');
    assert.ok($('button').find(b => b.textContent?.startsWith('Screen')), 'no Screen tab');
  });

  check('Screen mode hides the log pane', async () => {
    click($('button').find(b => b.textContent?.startsWith('Screen')));
  });
  await tick();
  check('log pane is gone in Screen mode', () => {
    assert.equal($('.pane.log').length, 0, 'log pane still rendered');
  });

  check('the filter box narrows the log', async () => {
    click($('button').find(b => b.textContent === 'Split'));
  });
  await tick();
  const filter = $('input.filter')[0];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(filter, 'findMany');
  filter.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  check('only the matching entry remains', () => assert.equal($('.entry .title').length, 1));

  // Occasional actions live behind the `⋯` overflow menu so the tab strip keeps
  // its width; opening it is part of the interaction now.
  click($('button').find(b => b.textContent === '⋯'));
  await tick();
  check('the overflow menu opens with the occasional actions', () => {
    const labels = $('.overflow-item').map(b => b.textContent);
    assert.ok(labels.some(l => l.includes('Copy report')), `copy missing: ${JSON.stringify(labels)}`);
    assert.ok(labels.some(l => l.includes('Clear capture')), 'clear missing');
    assert.ok(labels.some(l => l.includes('Dump raw')), 'dump missing');
  });

  click($('.overflow-item').find(b => b.textContent.includes('Clear capture')));
  await tick();
  click($('button').find(b => b.textContent === '⋯'));
  await tick();
  click($('.overflow-item').find(b => b.textContent.includes('Dump raw')));
  await tick();
  check('menu actions post to the extension', () => {
    assert.ok(posted.some(m => m.type === 'clear'), 'clear not posted');
    assert.ok(posted.some(m => m.type === 'dumpRaw'), 'dumpRaw not posted');
  });

  check('the menu closes after choosing an item', () => {
    assert.equal($('.overflow-menu').length, 0, 'menu stayed open');
  });

  // An attach failure must be actionable, not a blank pane.
  deliver({ ...PAYLOAD, status: 'error', statusDetail: 'Nothing is listening on port 9222.' });
  await tick();
  check('an attach error renders a recovery state', () => {
    assert.ok(text().includes('Not attached'), 'error state missing');
    assert.ok(text().includes('Nothing is listening on port 9222.'), 'error detail missing');
  });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
