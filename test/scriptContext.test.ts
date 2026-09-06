/**
 * What a script is written against, per surface.
 *
 * The trigger bindings come from the platform's own `fuuz-data-model` skill, and the
 * asymmetric nullability is the part people get wrong — so it is pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowNodeScaffold, nodesThatRan, nodesWithOutput, screenBindings, screenStateScaffold, skeletonRecord,
  TRIGGER_BINDINGS, triggerScaffold,
} from '../src/core/scriptContext';
import type { ModelShape } from '../src/core/modelTree';

const ORDER: ModelShape = {
  name: 'Order',
  fields: [
    { name: 'id', type: 'ID!', baseType: 'ID', required: true, list: false, relation: false },
    { name: 'quantity', type: 'Int', baseType: 'Int', required: false, list: false, relation: false },
    { name: 'shipped', type: 'Boolean', baseType: 'Boolean', required: false, list: false, relation: false },
    { name: 'lines', type: '[OrderLine!]', baseType: 'OrderLine', required: false, list: true, relation: true },
  ],
  summary: { fields: 4, relations: 1, required: 1 },
};

/* ── Trigger bindings ─────────────────────────────────────────────────────── */

// `$before` is null on create. Binding it anyway would let someone write
// `$before.quantity`, watch it work here, and have it fail against a null in production.
test('create binds no before', () => {
  const { context } = triggerScaffold(ORDER, 'create');
  const parsed = JSON.parse(context);
  assert.equal(parsed.before, null);
  assert.notEqual(parsed.after, null);
  assert.equal('where' in parsed, false);
});

test('update binds before, after and where', () => {
  const parsed = JSON.parse(triggerScaffold(ORDER, 'update').context);
  assert.ok(parsed.before);
  assert.ok(parsed.after);
  assert.ok(parsed.where);
});

// `$` is not set on delete — the record has to be read from `$before`.
test('delete has no document and no after', () => {
  const { payload, context } = triggerScaffold(ORDER, 'delete');
  assert.deepEqual(JSON.parse(payload), {});
  const parsed = JSON.parse(context);
  assert.ok(parsed.before);
  assert.equal(parsed.after, null);
  assert.equal(TRIGGER_BINDINGS.delete.document, 'unset');
});

// Absent and null are different diagnoses: a missing key completes as "not found".
test('an unbound binding is explicitly null, not absent', () => {
  const parsed = JSON.parse(triggerScaffold(ORDER, 'create').context);
  assert.equal('before' in parsed, true);
  assert.equal(parsed.before, null);
});

test('the payload is the mutation input on create and update', () => {
  for (const op of ['create', 'update'] as const) {
    assert.equal(JSON.parse(triggerScaffold(ORDER, op).payload).quantity, 0);
  }
});

/* ── Skeleton records, so fields complete before any data exists ──────────── */

test('placeholders are type-shaped, not null', () => {
  const skeleton = skeletonRecord(ORDER);
  assert.equal(typeof skeleton.id, 'string');
  assert.equal(typeof skeleton.quantity, 'number');
  assert.equal(typeof skeleton.shipped, 'boolean');
});

test('a relation is an object with an id, which is how it arrives', () => {
  assert.deepEqual(skeletonRecord(ORDER).lines, [{ id: 'id' }]);
});

/* ── Screen bindings ──────────────────────────────────────────────────────── */

// The runtime never logs the function bag, so completing against the captured context
// alone stopped dead at the element.
test('an element’s fn bag is folded into the captured context', () => {
  const bound = screenBindings(
    { components: { Table1: { data: [] } }, metadata: {} },
    [{ name: 'Table1', type: 'Table' }]
  ) as { components: Record<string, { data?: unknown; fn?: Record<string, string> }> };
  assert.ok(bound.components.Table1.fn, 'expected an fn bag on Table1');
  assert.deepEqual(bound.components.Table1.data, []);
});

test('the captured values are preserved alongside', () => {
  const bound = screenBindings({ metadata: { tenantId: 't' } }, []) as { metadata: unknown };
  assert.deepEqual(bound.metadata, { tenantId: 't' });
});

// Before any capture, the design's elements alone still make the paths completable.
test('with no capture the elements still bind', () => {
  const bound = screenBindings(undefined, [{ name: 'Table1', type: 'Table' }]) as
    { components: Record<string, unknown> };
  assert.ok('Table1' in bound.components);
});

/* ── Flow node payloads ───────────────────────────────────────────────────── */

// Offering a node that never ran would load an empty payload and look broken.
test('only nodes that produced output are offered', () => {
  const picked = nodesWithOutput([
    { node: 'A', key: 'a', status: 'ok', output: { x: 1 } },
    { node: 'B', key: 'b', status: 'ok' },
  ]);
  assert.deepEqual(picked.map((r) => r.node), ['A']);
});

// A node that ran several times appears once, at the run you are debugging.
test('a repeated node appears once, at its newest run', () => {
  const picked = nodesWithOutput([
    { node: 'A', key: 'a1', status: 'ok', output: { attempt: 1 } },
    { node: 'A', key: 'a2', status: 'ok', output: { attempt: 2 } },
  ]);
  assert.equal(picked.length, 1);
  assert.deepEqual(picked[0].output, { attempt: 2 });
});

test('a node’s state is bound as $state, not spread across the context', () => {
  const { payload, context } = flowNodeScaffold({
    node: 'A', key: 'a', status: 'ok', output: { rows: 2 }, state: { orderId: 'X' },
  });
  assert.deepEqual(JSON.parse(payload), { rows: 2 });
  assert.deepEqual(JSON.parse(context), { state: { orderId: 'X' } });
});

test('no runs yields no options rather than throwing', () => {
  assert.deepEqual(nodesWithOutput(), []);
});

/* ── Screen-state mode: the whole screen in both boxes ────────────────────── */

const CAPTURE = {
  components: {
    AssetIntakeForm: { data: { title: 'Pump' }, disabled: false },
    TicketTable: { rows: [1, 2, 3] },
  },
  metadata: { tenantId: 'buildMfgx' },
};

// The payload becomes every element's state, so the whole screen is one object you can
// browse and complete into rather than assembling it by hand from the log.
test('the payload holds every element’s live state', () => {
  const { payload, elements } = screenStateScaffold(CAPTURE);
  const parsed = JSON.parse(payload);
  assert.deepEqual(Object.keys(parsed).sort(), ['AssetIntakeForm', 'TicketTable']);
  assert.deepEqual(parsed.AssetIntakeForm.data, { title: 'Pump' });
  assert.equal(elements, 2);
});

// The context keeps the *real* bindings, because an expression written against those is
// the one that transfers to the designer.
test('the context keeps the runtime bindings', () => {
  const parsed = JSON.parse(screenStateScaffold(CAPTURE).context);
  assert.deepEqual(parsed.metadata, { tenantId: 'buildMfgx' });
  assert.ok(parsed.components.TicketTable);
});

// A screen transform has no `$`, so `$.Form1.data` will not work pasted into one. That has
// to be said rather than left to be discovered.
test('the note says the payload is a convenience, not a runtime binding', () => {
  const { note } = screenStateScaffold(CAPTURE);
  assert.match(note, /\$components/);
  assert.match(note, /2 elements/);
});

test('an empty capture says so instead of showing an empty object', () => {
  const { note, elements } = screenStateScaffold({});
  assert.equal(elements, 0);
  assert.match(note, /No element state has been captured/);
});

test('a missing or malformed capture does not throw', () => {
  for (const input of [undefined, null, 'nonsense', 42, []]) {
    assert.doesNotThrow(() => screenStateScaffold(input));
    assert.equal(screenStateScaffold(input).elements, 0);
  }
});

/* ── The node picker: every node that ran ─────────────────────────────────── */

// The picker was built from the runs still carrying payloads, and those are capped by a byte budget —
// so one integration node returning a large API response consumed the whole allowance and every other
// node vanished. Having run is the fact worth listing.
test('every node that ran is listed, whatever its payload size', () => {
  const listed = nodesThatRan([
    { node: 'Call API', runs: 1, totalMs: 812 },
    { node: 'Transform', runs: 1, totalMs: 3 },
    { node: 'Save', runs: 4, totalMs: 40 },
  ]);
  assert.deepEqual(listed.map((n) => n.node), ['Call API', 'Transform', 'Save']);
});

// A node that threw is often exactly the one whose input you want to see.
test('a failed node is listed and marked', () => {
  const listed = nodesThatRan([{ node: 'Call API', runs: 1, failed: 1 }]);
  assert.equal(listed[0].failed, true);
});

test('run counts and durations come through for the label', () => {
  const listed = nodesThatRan([{ node: 'For Each', runs: 8, totalMs: 120 }]);
  assert.deepEqual(listed, [{ node: 'For Each', runs: 8, totalMs: 120, failed: false }]);
});

// A node that never ran has no output to offer, so listing it would load an empty payload.
test('a node with no runs is not offered', () => {
  assert.deepEqual(nodesThatRan([{ node: 'Never', runs: 0 }]), []);
});

test('a repeated summary entry appears once', () => {
  const listed = nodesThatRan([{ node: 'A', runs: 1 }, { node: 'A', runs: 2 }]);
  assert.equal(listed.length, 1);
});

test('an empty or absent summary yields no options rather than throwing', () => {
  assert.deepEqual(nodesThatRan(), []);
  assert.deepEqual(nodesThatRan([]), []);
});
