/**
 * Reaching a live Fuuz component from its DOM node.
 *
 * This is the step everything mutable depends on, and it is done first
 * deliberately: if a component cannot be reached, then "edit this property" can
 * only ever mean "poke the DOM and watch React overwrite it", and the panel must
 * say so rather than offer a control that quietly does nothing.
 *
 * The app publishes no global handle — `window.__fuuz*` and `window.fuuz*` are
 * both empty — so the only route is React's own per-node back-reference. React
 * attaches it to the DOM element under a key suffixed with a per-build random
 * number (`__reactFiber$abc123`), which is why these are found by prefix.
 *
 * Nothing here mutates. Discovery only.
 */

/** React's DOM → fiber back-references, oldest key form last. */
const FIBER_KEYS = ['__reactFiber$', '__reactInternalInstance$'];

interface FiberLike {
  return?: FiberLike | null;
  stateNode?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  type?: unknown;
  elementType?: unknown;
}

function fiberFor(node: Element): FiberLike | undefined {
  for (const key of Object.keys(node)) {
    if (FIBER_KEYS.some((p) => key.startsWith(p))) {
      return (node as unknown as Record<string, FiberLike>)[key];
    }
  }
  return undefined;
}

/** A component's display name, however React happens to carry it. */
function nameOf(fiber: FiberLike): string | undefined {
  const t = (fiber.elementType ?? fiber.type) as
    | { displayName?: string; name?: string }
    | string
    | undefined;
  if (typeof t === 'string') return t;
  return t?.displayName ?? t?.name ?? undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** An `fn` bag is an object of functions — that is the whole test. */
function fnBagIn(props: Record<string, unknown> | null | undefined): string[] | undefined {
  if (!isRecord(props)) return undefined;
  const bag = props.fn;
  if (!isRecord(bag)) return undefined;
  const keys = Object.keys(bag).filter((k) => typeof bag[k] === 'function');
  return keys.length ? keys.sort() : undefined;
}

export interface FiberProbe {
  /** Whether a DOM node was found at all — distinguishes locate from reach. */
  located: boolean;
  /** Whether a component carrying an `fn` bag was reached. */
  reached: boolean;
  /** Component names walked, nearest first — the evidence for what was found. */
  path: string[];
  /** The `fn` keys visible on the reached component. */
  fnKeys: string[];
  /** Other prop names on that component, for orientation. */
  propKeys: string[];
  /** How many fibers were walked before giving up or succeeding. */
  depth: number;
  note?: string;
}

/**
 * Walk from a DOM node up to the nearest component exposing an `fn` bag.
 *
 * Bounded: a Fuuz element sits a handful of fibers below its component, and an
 * unbounded walk would climb into the app shell and report a bag belonging to
 * something else entirely — a wrong answer being worse than none.
 */
export function probeFiber(node: Element | null, maxDepth = 30): FiberProbe {
  const out: FiberProbe = { located: !!node, reached: false, path: [], fnKeys: [], propKeys: [], depth: 0 };
  if (!node) { out.note = 'No DOM node matched this element.'; return out; }

  let fiber = fiberFor(node);
  if (!fiber) {
    out.note = 'The DOM node carries no React fiber — either this build strips them, or the node is not React-rendered.';
    return out;
  }

  for (let i = 0; i < maxDepth && fiber; i += 1) {
    out.depth = i + 1;
    const name = nameOf(fiber);
    if (name) out.path.push(name);

    const keys = fnBagIn(fiber.memoizedProps);
    if (keys) {
      out.reached = true;
      out.fnKeys = keys;
      out.propKeys = Object.keys(fiber.memoizedProps ?? {}).sort();
      return out;
    }
    fiber = fiber.return ?? undefined;
  }

  out.note = `Walked ${out.depth} fibers without finding an fn bag. Live editing on this element can only be a preview.`;
  return out;
}

/**
 * Call one function from a reached component's `fn` bag.
 *
 * The only mutating entry point, and it goes through the runtime's own API —
 * so dependent transforms re-fire and the panel captures them, which a DOM poke
 * could never produce. Never throws; the caller shows the reason instead.
 */
export function callFn(
  node: Element | null,
  name: string,
  args: unknown[],
  maxDepth = 30
): { ok: boolean; result?: unknown; error?: string } {
  if (!node) return { ok: false, error: 'No DOM node matched this element.' };

  let fiber = fiberFor(node);
  for (let i = 0; i < maxDepth && fiber; i += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props) && isRecord(props.fn) && typeof props.fn[name] === 'function') {
      try {
        const result = (props.fn[name] as (...a: unknown[]) => unknown)(...args);
        // A returned promise would resolve after we reply, so report the call as
        // dispatched rather than pretending to know its outcome.
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          return { ok: true, result: '(async — dispatched, result not awaited)' };
        }
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    fiber = fiber.return ?? undefined;
  }
  return { ok: false, error: `No component in scope exposes fn.${name}().` };
}
