/**
 * Joining the element tree to the state tree.
 *
 * The three distinctions under test are the ones that were impossible to see
 * when Structure and State were separate tabs: an element with no state, state
 * with no element, and state that exists but is empty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  componentState, filterMerged, findInState, flattenMerged, matchesQuery, mergeScreen, stateSummary,
} from '../src/core/elementState';
import type { StructureNode } from '../src/core/structure';
import type { StateNode } from '../src/core/types';

const el = (name: string, children: StructureNode[] = []): StructureNode => ({
  nodeId: `${name}00`, name, named: true, type: 'Container',
  props: [], stylable: true, children,
});

const sn = (label: string, children?: StateNode[], value?: string): StateNode => ({
  id: label, label, type: 'object', vk: 'obj', value, children, trace: [], changed: false,
});

const STRUCTURE = [el('IntakePage', [
  el('IntakeFormSlot', [el('AssetIntakeForm')]),
  el('UploaderSlot', [el('TusUploader')]),
])];

const STATE: StateNode[] = [sn('Screen', [
  sn('metadata', [sn('user', [sn('id', undefined, '"clbl0001"')])]),
  sn('components', [
    sn('AssetIntakeForm', [sn('data', [sn('title', undefined, '"Screen Runner capture"')]), sn('loading', undefined, 'false')]),
    sn('TicketTable', [sn('data', undefined, '[ 0 items ]')]),
    sn('UploaderSlot', []),
  ]),
])];

/* ── The join ────────────────────────────────────────────────────────────── */

test('state hangs off the element that owns it', () => {
  const merged = mergeScreen(STRUCTURE, STATE);
  const flat = flattenMerged(merged.elements);
  const form = flat.find((f) => f.node.element.name === 'AssetIntakeForm')!.node;
  assert.equal(form.hasState, true);
  assert.deepEqual(form.stateKeys, ['data', 'loading']);
});

test('the element tree keeps its shape and depth', () => {
  const flat = flattenMerged(mergeScreen(STRUCTURE, STATE).elements);
  assert.deepEqual(flat.map((f) => `${'  '.repeat(f.depth)}${f.node.element.name}`), [
    'IntakePage',
    '  IntakeFormSlot',
    '    AssetIntakeForm',
    '  UploaderSlot',
    '    TusUploader',
  ]);
});

// Never rendered, or never ran its query — a different bug from wrong values.
test('an element with no state at all is marked, not left ambiguous', () => {
  const merged = mergeScreen(STRUCTURE, STATE);
  const flat = flattenMerged(merged.elements);
  const uploader = flat.find((f) => f.node.element.name === 'TusUploader')!.node;
  assert.equal(uploader.hasState, false);
  assert.equal(stateSummary(uploader), 'no state');
  assert.equal(merged.withoutState, 3, 'IntakePage, IntakeFormSlot and TusUploader hold none');
});

test('state that exists but is empty reads differently from absent state', () => {
  const flat = flattenMerged(mergeScreen(STRUCTURE, STATE).elements);
  const slot = flat.find((f) => f.node.element.name === 'UploaderSlot')!.node;
  assert.equal(slot.hasState, true, 'the runtime does hold something for it');
  assert.deepEqual(slot.stateKeys, []);
  assert.notEqual(stateSummary(slot), 'no state');
});

// An orphan is evidence the element tree is incomplete — a collapsed designer
// row, a filtered tree, a stale design. Dropping it would hide that.
test('component state with no element is surfaced, never dropped', () => {
  const merged = mergeScreen(STRUCTURE, STATE);
  assert.deepEqual(merged.orphans.map((o) => o.label), ['TicketTable']);
});

test('screen-level roots come through without the wrapper level', () => {
  const merged = mergeScreen(STRUCTURE, STATE);
  assert.deepEqual(merged.screen.map((s) => s.label), ['metadata']);
});

test('an unwrapped state tree works too', () => {
  const merged = mergeScreen(STRUCTURE, [sn('components', [sn('AssetIntakeForm', [sn('data')])]), sn('metadata')]);
  const flat = flattenMerged(merged.elements);
  assert.equal(flat.find((f) => f.node.element.name === 'AssetIntakeForm')!.node.hasState, true);
  assert.deepEqual(merged.screen.map((s) => s.label), ['metadata']);
});

test('no state at all still yields the full element tree', () => {
  const merged = mergeScreen(STRUCTURE, []);
  assert.equal(flattenMerged(merged.elements).length, 5);
  assert.deepEqual(merged.orphans, []);
});

test('no structure still surfaces every component as an orphan', () => {
  const merged = mergeScreen([], STATE);
  assert.deepEqual(merged.orphans.map((o) => o.label), ['AssetIntakeForm', 'TicketTable', 'UploaderSlot']);
});

/* ── Search ──────────────────────────────────────────────────────────────── */

test('a query matches an element by name, type or state key', () => {
  const merged = mergeScreen(STRUCTURE, STATE);
  const form = flattenMerged(merged.elements).find((f) => f.node.element.name === 'AssetIntakeForm')!.node;
  assert.equal(matchesQuery(form, 'assetintake'), true);
  assert.equal(matchesQuery(form, 'loading'), true, 'state keys are searchable');
  assert.equal(matchesQuery(form, 'nonsense'), false);
});

// Filtering to matches alone would orphan them visually; ancestors must survive.
test('filtering keeps the ancestors of a match', () => {
  const merged = mergeScreen(STRUCTURE, STATE);
  const flat = flattenMerged(filterMerged(merged.elements, 'AssetIntakeForm'));
  assert.deepEqual(flat.map((f) => f.node.element.name),
    ['IntakePage', 'IntakeFormSlot', 'AssetIntakeForm']);
});

test('an empty query filters nothing', () => {
  const merged = mergeScreen(STRUCTURE, STATE);
  assert.equal(flattenMerged(filterMerged(merged.elements, '  ')).length, 5);
});

test('findInState reaches values nested inside an element', () => {
  const merged = mergeScreen(STRUCTURE, STATE);
  const form = flattenMerged(merged.elements).find((f) => f.node.element.name === 'AssetIntakeForm')!.node;
  assert.equal(findInState(form.state, 'Screen Runner'), true);
  assert.equal(findInState(form.state, 'title'), true);
  assert.equal(findInState(form.state, 'absent'), false);
});

/* ── Raw context reads ───────────────────────────────────────────────────── */

test('componentState separates a missing component from a null one', () => {
  const ctx = { components: { A: { data: 1 }, B: null } };
  assert.deepEqual(componentState(ctx, 'A'), { found: true, value: { data: 1 } });
  assert.deepEqual(componentState(ctx, 'B'), { found: true, value: null });
  assert.deepEqual(componentState(ctx, 'C'), { found: false });
  assert.deepEqual(componentState(undefined, 'A'), { found: false });
});
