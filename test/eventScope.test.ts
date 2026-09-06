/**
 * Tying entries to the screen event that produced them.
 *
 * The rules under test are the ones the runtime does *not* give us: it emits a
 * flat stream with a component-type `trace.origin` and nothing else, so grouping
 * is inferred from capture order plus an idle gap. These tests pin the inference
 * — especially the places it must *decline* (before any interaction, and after a
 * quiet gap), because an over-eager grouping would attribute a subscription push
 * to whatever the user last clicked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignEventScopes, isEventRoot, traceOrigin, EVENT_ORIGINS } from '../src/core/eventScope';
import type { LogEntry } from '../src/core/types';

let seq = 0;

/** An entry shaped the way `classify` emits one, with a controllable trace + clock. */
const entry = (opts: {
  origin?: string; actionName?: string; menuTitle?: string;
  property?: string; epoch?: number; kind?: LogEntry['kind'];
}): LogEntry => {
  const n = ++seq;
  return {
    id: `e${n}`, seq: n, ts: '10:24:31.000', epoch: opts.epoch ?? n,
    kind: opts.kind ?? 'debug', title: `Transform Debugging · ${opts.property ?? 'label'}`,
    dur: '1ms', write: `components.Widget.${opts.property ?? 'label'}`, reads: [], level: 'debug',
    payload: ['Transform Debugging: ', {
      trace: {
        property: opts.property ?? 'label',
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.actionName ? { actionName: opts.actionName } : {}),
        ...(opts.menuTitle ? { menuTitle: opts.menuTitle } : {}),
      },
    }],
  };
};

/* ── Roots ───────────────────────────────────────────────────────────────── */

test('traceOrigin reads the component-type label the runtime writes', () => {
  assert.equal(traceOrigin(entry({ origin: 'Action', actionName: 'Save' })), 'Action');
  assert.equal(traceOrigin(entry({})), undefined);
});

test('interaction origins open a scope; layout origins do not', () => {
  assert.ok(isEventRoot(entry({ origin: 'Action', actionName: 'Save' })));
  assert.ok(isEventRoot(entry({ origin: 'Flow Button' })));
  // Consequences, not causes: a container recomputing is work an event caused.
  assert.equal(isEventRoot(entry({ origin: 'Container' })), false);
  assert.equal(isEventRoot(entry({ origin: 'GridCell' })), false);
  assert.equal(isEventRoot(entry({})), false);
});

test('a flow call is an event even with no origin', () => {
  assert.ok(isEventRoot(entry({ kind: 'flow' })));
});

test('the origin list matches the components that name an interaction', () => {
  for (const o of ['Action', 'ActionAdapter', 'Flow Button', 'FlowAdapter', 'MenuBarItem']) {
    assert.ok(EVENT_ORIGINS.has(o), `${o} should open a scope`);
  }
});

/* ── Scoping ─────────────────────────────────────────────────────────────── */

test('entries following an interaction join it, numbered serially within it', () => {
  const log = [
    entry({ origin: 'Action', actionName: 'Save', epoch: 1000 }),
    entry({ property: 'disabled', epoch: 1010 }),
    entry({ property: 'label', epoch: 1020 }),
  ];
  const { entries, scopes } = assignEventScopes(log);

  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].label, 'Save');
  assert.equal(scopes[0].count, 3);
  assert.deepEqual(entries.map((e) => e.eventSeq), [1, 2, 3]);
  assert.deepEqual(entries.map((e) => e.eventVia), ['root', 'follow', 'follow']);
  assert.ok(entries.every((e) => e.eventId === scopes[0].id));
});

test('the scope id derives from the root entry, so re-running agrees', () => {
  const log = [entry({ origin: 'Action', actionName: 'Save' }), entry({ property: 'x' })];
  const first = assignEventScopes(log);
  const second = assignEventScopes(log);
  assert.equal(first.scopes[0].id, second.scopes[0].id);
  assert.equal(first.scopes[0].id, `evt-${log[0].id}`);
});

test('a second interaction closes the first', () => {
  const log = [
    entry({ origin: 'Action', actionName: 'Save', epoch: 1000 }),
    entry({ property: 'disabled', epoch: 1010 }),
    entry({ origin: 'Action', actionName: 'Refresh', epoch: 1020 }),
    entry({ property: 'rows', epoch: 1030 }),
  ];
  const { entries, scopes } = assignEventScopes(log);
  assert.deepEqual(scopes.map((s) => s.label), ['Save', 'Refresh']);
  assert.deepEqual(scopes.map((s) => s.count), [2, 2]);
  assert.equal(entries[3].eventLabel, 'Refresh');
  assert.deepEqual(scopes.map((s) => s.seq), [1, 2]);
});

test('entries before any interaction belong to no event', () => {
  const log = [entry({ property: 'label', epoch: 1000 }), entry({ origin: 'Action', actionName: 'Save', epoch: 1010 })];
  const { entries } = assignEventScopes(log);
  assert.equal(entries[0].eventId, undefined);
  assert.equal(entries[0].eventVia, 'unscoped');
  assert.equal(entries[1].eventVia, 'root');
});

test('a quiet gap closes the scope, so a later push is not blamed on the last click', () => {
  const log = [
    entry({ origin: 'Action', actionName: 'Save', epoch: 1000 }),
    entry({ property: 'disabled', epoch: 1010 }),
    entry({ property: 'rows', epoch: 9000 }),   // 8s later — a subscription, not this click
  ];
  const { entries, scopes } = assignEventScopes(log);
  assert.equal(scopes[0].count, 2);
  assert.equal(entries[2].eventId, undefined);
  assert.equal(entries[2].eventVia, 'unscoped');
});

test('the idle gap is configurable', () => {
  const log = [
    entry({ origin: 'Action', actionName: 'Save', epoch: 1000 }),
    entry({ property: 'rows', epoch: 4000 }),
  ];
  assert.equal(assignEventScopes(log, { idleMs: 5000 }).entries[1].eventVia, 'follow');
  assert.equal(assignEventScopes(log, { idleMs: 100 }).entries[1].eventVia, 'unscoped');
});

test('labels fall back to the origin when the runtime named nothing', () => {
  const { scopes } = assignEventScopes([entry({ origin: 'Flow Button' })]);
  assert.equal(scopes[0].label, 'Flow Button');
});

test('a menu item is labelled by its title', () => {
  const { scopes } = assignEventScopes([entry({ origin: 'MenuBarItem', menuTitle: 'Export' })]);
  assert.equal(scopes[0].label, 'Export');
});

test('scoping does not reorder or drop entries', () => {
  const log = [entry({}), entry({ origin: 'Action', actionName: 'Save' }), entry({})];
  const { entries } = assignEventScopes(log);
  assert.deepEqual(entries.map((e) => e.id), log.map((e) => e.id));
  assert.equal(entries.length, log.length);
});

test('an empty log produces no scopes rather than throwing', () => {
  const { entries, scopes } = assignEventScopes([]);
  assert.deepEqual(entries, []);
  assert.deepEqual(scopes, []);
});
