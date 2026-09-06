// The whole pipeline, over a real capture.
//
// Every other suite tests one module against inputs chosen to exercise it. This
// one takes the console events and screen design captured live from Asset
// Intake on admin.fuuz.app and runs them through classify → state tree →
// diagnose → structure → property rows → completions → report, asserting on
// what actually comes out.
//
// It is the test most likely to catch a change that keeps every unit passing
// while breaking the thing the tool is for.
import * as fs from 'fs';
import { classify } from '../out/src/core/classify.js';
import { buildStateTree } from '../out/src/core/stateTree.js';
import { diagnose } from '../out/src/core/diagnose.js';
import { buildStructure } from '../out/src/core/structure.js';
import { indexScreenDesign, applyDesign } from '../out/src/core/designJoin.js';
import { lintDesign } from '../out/src/core/designLint.js';
import { propertyRows } from '../out/src/core/propertyModel.js';
import { completionsAt } from '../out/src/core/completions.js';
import { toMarkdown } from '../out/src/core/report.js';
import { screenVersionIdFrom } from '../out/src/core/screenApi.js';
import { classifyEnvironment } from '../out/src/core/environment.js';

const read = (f) => JSON.parse(fs.readFileSync(`test/fixtures/${f}`, 'utf8'));

let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { fail++; console.error('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
};
const note = (k, v) => console.log(`      ${k.padEnd(22)} ${v}`);

const raw = read('transformDebug.json');
const design = read('screenDesign.assetSetupTable.json');

/* ── 1. Classification ───────────────────────────────────────────────────── */

console.log('\nclassify — real console events');
const entries = raw.map((e) => classify(e));
note('events', entries.length);
for (const e of entries) note('→', `${e.kind.padEnd(6)} ${e.title}`);

check('every event is classified, none fall through', entries.every((e) => !!e.kind));
check('the transform expression is captured',
  entries.some((e) => /assetCollection/.test(e.expr ?? '')));

/* ── 2. State ────────────────────────────────────────────────────────────── */

console.log('\nstate tree');
const tree = buildStateTree(entries, 'Asset Intake');
const roots = tree.map((n) => n.label);
note('roots', roots.join(', ') || '(none)');
check('a state tree is produced from the runtime context', tree.length > 0, JSON.stringify(roots));

const context = [...entries].reverse().find((e) => e.context)?.context;
check('a context snapshot is recovered', !!context);
note('screenVersionId', screenVersionIdFrom(context, '') ?? '(none)');
check('the screen version comes from the context, no URL needed',
  screenVersionIdFrom(context, '') === 'cmsvvlf7u0jal016k5ztgfqs4');

/* ── 3. Diagnosis ────────────────────────────────────────────────────────── */

console.log('\ndiagnose');
const issues = diagnose(entries, []);
for (const i of issues) note(i.rule, i.title);
check('the real capture yields at least one issue', issues.length > 0);

// Expect `unattributed-transform`: the captured console is from Asset Intake
// while the only design fixture is Asset Setup, so one transform genuinely has
// no element to bind to. That it *says so* rather than guessing an owner is the
// behaviour under test — a mismatched design must not produce a confident
// wrong attribution.
check('a transform with no matching design element is reported, not guessed',
  issues.some((i) => i.rule === 'unattributed-transform'),
  issues.map((i) => i.rule).join(', '));

// This particular capture is a *successful* run — `url` returned a working
// data: URI and nothing threw. So the assertion is that no failure is invented
// from it, which is the harder property to hold: a diagnoser that reports
// problems in a clean capture is worse than one that reports none.
const invented = issues.filter((i) => /error|fail|throw/i.test(i.rule));
check('no failure is invented from a clean capture', invented.length === 0,
  invented.map((i) => `${i.rule}: ${i.title}`).join(' | '));

/* ── 4. Design join ──────────────────────────────────────────────────────── */

console.log('\ndesign');
const index = indexScreenDesign({ name: 'Asset Setup', design });
const structure = buildStructure(design);
const flat = (function walk(ns) { return ns.flatMap((n) => [n, ...walk(n.children)]); })(structure);
note('elements in design', flat.length);
note('named elements', flat.filter((n) => n.named).length);
note('with transforms', flat.filter((n) => n.props.length).length);
check('the design parses into a structure tree', flat.length > 0);
check('element names survive the parse', flat.some((n) => n.named));

const joined = applyDesign(entries, index);
check('applying the design never loses entries', joined.length === entries.length);

const findings = lintDesign(index);
note('lint findings', findings.length ? findings.map((f) => f.rule).join(', ') : '(none)');

/* ── 5. Property inspector, on a real element ────────────────────────────── */

console.log('\nproperty inspector');
// Prefer a *named* element: an unnamed one is keyed by craft id, which cannot
// match `components.<name>` in the context, so every value would read as absent
// for a reason that has nothing to do with the inspector.
const withProps = flat.find((n) => n.named && n.props.length)
  ?? flat.find((n) => n.named && n.type !== 'Unknown')
  ?? flat[0];
note('element', `${withProps?.name} <${withProps?.type}>`);
note('named', String(withProps?.named));
const rows = propertyRows(withProps, context);
const states = rows.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {});
note('rows', rows.length);
note('by state', JSON.stringify(states));
check('a real element produces property rows', rows.length > 0);
check('rows carry descriptions from the skill',
  rows.some((r) => r.description), JSON.stringify(rows.slice(0, 2)));
check('every row states an edit tier', rows.every((r) => !!r.edit?.tier));

const runtimeRows = rows.filter((r) => r.edit.tier === 'runtime');
const noneRows = rows.filter((r) => r.edit.tier === 'none');
note('runtime-settable', runtimeRows.map((r) => r.name).join(', ') || '(none)');
note('not applicable', noneRows.map((r) => r.name).join(', ') || '(none)');

/* ── 6. Completions over the real context ────────────────────────────────── */

console.log('\ncompletions over live state');
const top = completionsAt('$', 1, { context });
note('top-level', top.items.map((i) => i.label).join(', '));
check('the runtime bindings complete', top.items.some((i) => i.label === 'components'));

const comps = completionsAt('$components.', 12, { context });
note('components', comps.items.map((i) => i.label).join(', ') || '(none)');

// The whole point: the failing path is visibly absent before you write anything.
const bad = completionsAt(
  '$components.AssetIntakeForm.data.assetCollection.',
  '$components.AssetIntakeForm.data.assetCollection.'.length,
  { context }
);
note('assetCollection.', bad.items.map((i) => `${i.label} ${i.preview}`).join(' | '));
check('the failing path reports itself as not found',
  bad.items.every((i) => i.kind === 'missing'), JSON.stringify(bad.items));

const good = completionsAt(
  '$components.AssetIntakeForm.data.',
  '$components.AssetIntakeForm.data.'.length,
  { context }
);
note('data.', good.items.map((i) => `${i.label}=${i.preview}`).join(' | ') || '(none)');
check('sibling paths that do exist show their values',
  good.items.length === 0 || good.items.some((i) => i.kind !== 'missing'),
  JSON.stringify(good.items));

// What this capture actually shows: the `disabled` transform reads
// assetCollection.id, the form never has it, so the button stays disabled and
// validation reports "Title must be provided". The completer surfaces the cause
// without running anything.
const disabledExpr = entries.find((e) => /assetCollection/.test(e.expr ?? ''));
note('the real bug', disabledExpr ? disabledExpr.expr.slice(0, 96) : '(not in this capture)');
check('the expression that gates the button is recoverable from the log', !!disabledExpr);

/* ── 7. Environment + report ─────────────────────────────────────────────── */

console.log('\nenvironment & report');
const env = classifyEnvironment('https://admin.fuuz.app/system/configuration/screens/x/run');
note('admin.fuuz.app', `${env.tier} — ${env.reason}`);
check('admin is permitted, as decided', env.tier === 'permitted');
check('a plain tenant is not',
  classifyEnvironment('https://mfgx.fuuz.app/app/wms').tier === 'production');

const md = toMarkdown({
  payload: { screenName: 'Asset Intake', status: 'attached', entries: joined, tree, dropped: 0, snapshotAt: '' },
  network: [], issues: [...issues, ...findings], pageUrl: 'https://admin.fuuz.app/x',
});
note('report', `${md.length} chars, ${md.split('\n').length} lines`);
check('the report renders', md.length > 200);
check('it leads with the screen name', /^# .*Asset Intake/m.test(md));

// A capture holds a live session token; a report is made to be pasted.
check('no JWT survives into the report', !/\beyJ[A-Za-z0-9_-]{8,}\./.test(md));

console.log(fail ? `\n${fail} failed` : '\nPASS');
process.exit(fail ? 1 : 0);
