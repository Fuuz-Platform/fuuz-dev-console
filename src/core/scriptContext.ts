/**
 * What a script is written *against*, per surface.
 *
 * The script tab started as a blank payload and a blank context, which is honest but
 * unhelpful: the whole difficulty in writing a Fuuz expression is knowing what is bound
 * and what is in it. Each surface answers that differently, so each gets its own
 * bindings:
 *
 *   screen        the captured runtime context — `$components`, `$metadata` — plus the
 *                 `fn` bag each element exposes, which the runtime never logs
 *   model trigger `$` is the mutation input and `$before` / `$after` / `$where` are the
 *                 record around it, with **per-operation nullability**
 *   flow node     `$` is that node's recorded output, `$state` its accumulated state
 *
 * Pure.
 */
import { functionsFor } from './elementRegistry';
import type { ModelShape } from './modelTree';

/* ── Model triggers ───────────────────────────────────────────────────────── */

export type TriggerOperation = 'create' | 'update' | 'delete';

/**
 * The trigger bindings, from the platform's own `fuuz-data-model` skill.
 *
 * Reproduced exactly because the nullability is the part people get wrong, and it is
 * not symmetrical:
 *
 *   `$`        the mutation input. **Not set for delete.**
 *   `$before`  the record before. **null for create.**
 *   `$after`   the projected record after. **null for delete.**
 *   `$where`   the predicate. Present on update and delete only.
 *
 * A tool that bound all four unconditionally would let you write
 * `$before.quantity` in a create trigger and see it work — then fail in production
 * against a null. Encoding the nullability is the point.
 */
export const TRIGGER_BINDINGS: Record<TriggerOperation, {
  document: 'input' | 'unset';
  before: boolean;
  after: boolean;
  where: boolean;
  note: string;
}> = {
  create: {
    document: 'input', before: false, after: true, where: false,
    note: '`$` is the create payload. `$before` is null — there is no prior record.',
  },
  update: {
    document: 'input', before: true, after: true, where: true,
    note: '`$` is the update payload. `$before` and `$after` are both set, and `$where` is the predicate.',
  },
  delete: {
    document: 'unset', before: true, after: false, where: true,
    note: '`$` is **not set** on delete. Read the record from `$before`; `$after` is null.',
  },
};

/**
 * A skeleton record for a model, so the fields autocomplete before any data exists.
 *
 * Values are type-shaped placeholders rather than nulls: a null completes as a value
 * with no type, and `"string"` at least tells you what the field holds. Relations are
 * an object with an id, which is how they arrive.
 */
export function skeletonRecord(shape: ModelShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of shape.fields) {
    out[field.name] = field.list ? [placeholder(field.baseType, field.relation)] : placeholder(field.baseType, field.relation);
  }
  return out;
}

function placeholder(baseType: string, relation: boolean): unknown {
  if (relation) return { id: 'id' };
  switch (baseType) {
    case 'ID': case 'String': return 'string';
    case 'Int': case 'BigInt': return 0;
    case 'Float': case 'Decimal': return 0.0;
    case 'Boolean': return false;
    case 'DateTime': case 'Date': return '1970-01-01T00:00:00.000Z';
    default: return null;
  }
}

export interface TriggerScaffold {
  /** JSON for the payload box — the mutation input, or a note that it is unset. */
  payload: string;
  /** JSON for the context box — `before` / `after` / `where` as the operation allows. */
  context: string;
  /** What is and is not bound, shown to the developer. */
  note: string;
}

/**
 * Prefilled boxes for a model trigger.
 *
 * `$` is JSONata's document, which is what the payload box already is, and the named
 * bindings are context keys — so this maps onto the existing runner with no special
 * casing at evaluation time.
 */
export function triggerScaffold(shape: ModelShape, operation: TriggerOperation): TriggerScaffold {
  const rules = TRIGGER_BINDINGS[operation];
  const record = skeletonRecord(shape);
  const context: Record<string, unknown> = {};
  // Explicitly null rather than absent: `$before` *is* null in a create trigger, and a
  // missing key would complete as "not found", which is a different diagnosis.
  context.before = rules.before ? record : null;
  context.after = rules.after ? record : null;
  if (rules.where) context.where = { id: 'string' };

  return {
    payload: rules.document === 'input' ? JSON.stringify(record, null, 2) : '{}',
    context: JSON.stringify(context, null, 2),
    note: rules.note,
  };
}

/* ── Screens ──────────────────────────────────────────────────────────────── */

/**
 * The screen's context, with each element's `fn` bag folded in.
 *
 * `$components.Table1.fn.refresh` is a real and useful thing to write, and the runtime
 * never logs the function bag — so completing against the captured context alone stops
 * dead at the element. The names come from the element registry, keyed by the type the
 * design gives each element.
 *
 * Marked with a placeholder string rather than a function, because this object exists to
 * be *completed against*, and a function value would render as `[Function]` in the
 * preview where the signature is more useful.
 */
export function screenBindings(
  context: unknown,
  elements: { name: string; type: string }[] = []
): unknown {
  if (context === null || typeof context !== 'object') {
    // No capture yet: the elements alone still make the component paths completable.
    return { components: fnBags(elements) };
  }
  const root = { ...(context as Record<string, unknown>) };
  const components = { ...(root.components as Record<string, unknown> | undefined) };
  for (const [name, bag] of Object.entries(fnBags(elements))) {
    const existing = components[name];
    components[name] = existing !== null && typeof existing === 'object'
      ? { ...(existing as Record<string, unknown>), fn: bag.fn }
      : bag;
  }
  root.components = components;
  return root;
}

/**
 * Screen-state mode's two boxes, filled from a live capture.
 *
 * The payload becomes **every element's current state**, keyed by element name, so the
 * whole screen is one object you can browse and complete into — `$.AssetIntakeForm.data`
 * — rather than something you have to assemble by hand from the log.
 *
 * That is a convenience and is labelled as one. A screen transform is not evaluated
 * against a document: the runtime binds `$components`, `$metadata` and friends, and there
 * is no `$`. So the context keeps the real bindings — an expression written against those
 * transfers to the designer unchanged — while the payload is a browsing aid. Saying so
 * matters, because an expression written as `$.Form1.data` will *not* work when pasted
 * into a screen.
 */
export function screenStateScaffold(context: unknown): {
  payload: string; context: string; note: string; elements: number;
} {
  const root = (context !== null && typeof context === 'object')
    ? (context as Record<string, unknown>)
    : {};
  const components = (root.components !== null && typeof root.components === 'object')
    ? root.components as Record<string, unknown>
    : {};
  const count = Object.keys(components).length;
  return {
    payload: JSON.stringify(components, null, 2),
    context: JSON.stringify(root, null, 2),
    elements: count,
    note: count
      ? `Payload holds the live state of ${count} element${count === 1 ? '' : 's'}, so \`$.<element>.<key>\` completes. `
        + 'A screen transform binds `$components` and has no `$` — use the context paths for anything you intend to paste back.'
      : 'No element state has been captured yet. Interact with the running screen, or turn on transform debugging.',
  };
}

function fnBags(elements: { name: string; type: string }[]): Record<string, { fn: Record<string, string> }> {
  const out: Record<string, { fn: Record<string, string> }> = {};
  for (const el of elements) {
    const fns = functionsFor(el.type);
    if (!fns.length) continue;
    // The signature is the useful preview — `refresh()` tells you nothing that
    // `refresh(variables?)` does not tell you better.
    const fn: Record<string, string> = {};
    for (const f of fns) fn[f.name] = f.signature || '()';
    out[el.name] = { fn };
  }
  return out;
}

/* ── Flow nodes ───────────────────────────────────────────────────────────── */

export interface FlowNodeRun {
  node: string;
  key: string;
  status: string;
  durationMs?: number;
  output?: unknown;
  state?: unknown;
}

/**
 * Nodes whose output can seed a payload, newest first.
 *
 * Only nodes that actually produced something: offering one that never ran would load
 * an empty payload and look like the picker was broken. A node that ran several times
 * appears once, at its most recent run, because that is the one you are debugging.
 */
export function nodesWithOutput(runs: FlowNodeRun[] = []): FlowNodeRun[] {
  const newestFirst = [...runs].reverse();
  const seen = new Set<string>();
  const out: FlowNodeRun[] = [];
  for (const run of newestFirst) {
    if (run.output === undefined || run.output === null) continue;
    if (seen.has(run.node)) continue;
    seen.add(run.node);
    out.push(run);
  }
  return out;
}

/** A node's output as payload JSON, and its accumulated state as context JSON. */
export function flowNodeScaffold(run: FlowNodeRun): { payload: string; context: string } {
  return {
    payload: JSON.stringify(run.output ?? {}, null, 2),
    // `$state` is what a flow expression reads, so the node's accumulated state is
    // bound under that name rather than spread across the context root.
    context: JSON.stringify({ state: run.state ?? {} }, null, 2),
  };
}


/**
 * Every node that executed, from the run summary.
 *
 * The picker used to be built from the runs that still *carried payloads*, and those are capped by a
 * byte budget — so one integration node returning a large API response consumed the whole allowance
 * and every other node vanished from the list. The node having run is the fact worth listing; its
 * payload is fetched when you pick it.
 *
 * Failed nodes are included. A node that threw is often exactly the one whose input you want to look
 * at, and hiding it would remove the most useful case.
 */
export function nodesThatRan(
  summary: { node: string; runs: number; totalMs?: number; failed?: number }[] = []
): { node: string; runs: number; totalMs?: number; failed: boolean }[] {
  const seen = new Set<string>();
  return summary
    .filter((s) => s.node && s.runs > 0)
    .filter((s) => { if (seen.has(s.node)) return false; seen.add(s.node); return true; })
    .map((s) => ({ node: s.node, runs: s.runs, totalMs: s.totalMs, failed: (s.failed ?? 0) > 0 }));
}
