/**
 * Finding the DOM node for a Fuuz element — in the designer *and* in a running
 * screen.
 *
 * Highlighting worked in the designer and not at runtime, and the reason is that
 * the two surfaces label elements differently:
 *
 *   designer canvas   `data-screen-element` + `data-system-name` — the element's
 *                     own name, exact, put there for the designer's own tree
 *   running screen     none of that. The renderer emits `formelement` (owning
 *                     form), `field` (bound path) and `element` (type) — and only
 *                     on the element types that have those concepts.
 *
 * So a name-keyed selector list finds everything in the designer and, at runtime,
 * only form fields. A container, a button, a chart: nothing.
 *
 * The fix is to stop depending on knowing the attribute name in advance. Selectors
 * are tried first because they are exact and cheap; when they all miss, the caller
 * scans the document for **any attribute whose value is the element's name** and
 * ranks the hits with {@link pickAttributeHit}. That works whatever the runtime
 * happens to call it, survives a renderer change, and reports which attribute
 * matched so the guess is auditable rather than silent.
 *
 * Pure — no DOM. The scan itself lives in the relay; the ordering and ranking are
 * here so they can be tested without a browser.
 */

export interface LocateTarget {
  name?: string;
  type?: string;
  dataPath?: string;
  label?: string;
  /**
   * A diagram node's own id (`data-nodeid`).
   *
   * Exact where a title match is not: a flow's definition and its canvas can disagree
   * about a node's display name — the canvas may wrap it, truncate it, or show a
   * configured title — while the id is the same string on both sides.
   */
  nodeId?: string;
}

/** One selector to try, with a note of what it means when it hits. */
export interface Attempt {
  selector: string;
  /** How the element was identified, carried back so the panel can say. */
  via: string;
}

const esc = (v: string) => v.replace(/["\\]/g, '\\$&');

/**
 * Selectors to try, most exact first.
 *
 * Order matters: `data-system-name` is the element's own name and cannot collide,
 * while `[element="Container"]` matches every container on the screen. Stopping at
 * the first hit is only correct because the list is ordered by precision.
 */
export function locateAttempts(t: LocateTarget): Attempt[] {
  const out: Attempt[] = [];
  const push = (selector: string, via: string) => { if (selector) out.push({ selector, via }); };

  /*
   * A diagram node id first, when we have one: it identifies exactly one node on the
   * canvas and cannot be confused with anything else in the document.
   */
  if (t.nodeId) push(`[data-nodeid="${esc(t.nodeId)}"]`, 'data-nodeid (diagram node)');

  if (t.name) {
    const n = esc(t.name);
    push(`[data-system-name="${n}"]`, 'data-system-name (designer canvas)');
    // Runtime attributes carrying a *name*. These are the ones a running screen
    // might use; each is exact when present, so all are tried before any
    // type-level guess.
    push(`[data-element-name="${n}"]`, 'data-element-name');
    push(`[data-fuuz-element="${n}"]`, 'data-fuuz-element');
    push(`[data-name="${n}"]`, 'data-name');
    // Containers render their element name as a DOM id. Built by hand because
    // `CSS.escape` is not universally present, and a throw here would take out
    // every later attempt.
    push(/^[A-Za-z][\w-]*$/.test(t.name) ? `#${t.name}` : '', 'element id');
    push(`[formelement="${n}"]`, 'formelement (owning form)');
    push(`[name="${n}"]`, 'name attribute');
  }

  /*
   * The bound field, which is what a running screen does expose.
   *
   * The *pair* is exact where either alone can collide: two forms on one screen
   * can both bind `title`.
   */
  if (t.dataPath) {
    const d = esc(t.dataPath);
    if (t.name) push(`[formelement="${esc(t.name)}"][field="${d}"]`, 'formelement + field');
    push(`[field="${d}"]`, 'field (bound path)');
    push(`[data-data-path="${d}"]`, 'data-data-path');
  }

  if (t.label) {
    push(`[data-label="${esc(t.label)}"]`, 'data-label');
    push(`[aria-label="${esc(t.label)}"]`, 'aria-label');
  }

  /*
   * Type-level selectors last, and only as a genuine last resort: they identify a
   * *kind* of element, not this one. Kept because for a screen with a single chart
   * they are right, and a wrong outline is easier to recognise than no outline —
   * but `via` says so, so the panel can mark it approximate.
   */
  if (t.type) {
    push(`[data-screen-element="${esc(t.type)}"]`, `first ${t.type} on the screen (approximate)`);
    push(`[element="${esc(t.type)}"]`, `first ${t.type} on the screen (approximate)`);
  }

  return out;
}

/** True when `via` identified a kind of element rather than this one. */
export const isApproximate = (via: string) => via.includes('approximate');

/** One element found by scanning attribute values. */
export interface AttributeHit {
  /** The attribute whose value matched. */
  attr: string;
  /** How deep in the document, so an outer wrapper can be preferred. */
  depth: number;
  /** Rendered area in px²; zero means nothing to outline. */
  area: number;
}

/**
 * Attributes that mean "this element is named X" rather than happening to contain
 * the same string. Anything not listed still counts — the whole point of the scan
 * is to find attributes we have not seen — it just ranks below these.
 */
const ATTR_RANK = [
  'data-system-name', 'data-element-name', 'data-fuuz-element', 'data-name',
  'id', 'formelement', 'name', 'data-testid', 'aria-label',
];

/**
 * The best of several attribute matches.
 *
 * Two rules, both learned from what goes wrong without them:
 *
 *  - **Zero-area elements are discarded.** A hidden wrapper matches as readily as
 *    the visible element and outlining it draws a box of nothing, which reads as
 *    "the highlight is broken".
 *  - **Among equally-ranked attributes, the shallowest wins.** A name usually
 *    appears on a wrapper *and* is echoed by its children; the wrapper is the
 *    element the developer means.
 */
export function pickAttributeHit(hits: AttributeHit[]): AttributeHit | undefined {
  const usable = hits.filter((h) => h.area > 0);
  if (!usable.length) return undefined;
  const rank = (h: AttributeHit) => {
    const i = ATTR_RANK.indexOf(h.attr);
    return i === -1 ? ATTR_RANK.length : i;
  };
  return usable.slice().sort((a, b) => rank(a) - rank(b) || a.depth - b.depth || b.area - a.area)[0];
}

/**
 * Whether an attribute value names this element.
 *
 * Exact, or a dotted qualification of it — the design stores component names as
 * `custom.elementName`, and a runtime attribute carrying `Form1.title` is still
 * naming `title`. A substring match is deliberately *not* accepted: `Title` must
 * not match `TitleBarSubheading`.
 */
export function attributeNames(value: string, name: string): boolean {
  if (!value || !name) return false;
  if (value === name) return true;
  const cut = value.lastIndexOf('.');
  return cut > -1 && value.slice(cut + 1) === name;
}


/* ── Growing the outline to the field, not the bare control ───────────────── */

/** One ancestor of a located element, as the relay measured it. */
export interface Ancestor {
  /** Rendered area in px². */
  area: number;
  /**
   * Whether this ancestor contains a Fuuz element *other than* the one we located.
   *
   * The stop condition. Climbing past it would draw one outline around two elements, which
   * is worse than an outline that is slightly too tight.
   */
  containsOther: boolean;
}

/**
 * How many levels to climb from a located element to its field container.
 *
 * A running screen puts its marker attributes on the **control** — the `<input>`, the
 * select — while what a developer means by "that field" is the control plus its label and
 * helper text. Outlining only the control looks like the highlight is off by a bit, and on a
 * select it can be a 20px box beside the thing you were pointing at.
 *
 * So the outline grows, under two constraints that keep it honest:
 *
 *  - **Never past an ancestor holding another element.** That is what stops a field's
 *    outline from swallowing its neighbour, or the whole form.
 *  - **Only while the box is actually growing.** A wrapper the same size as its child adds
 *    nothing, and climbing through several of them would be motion with no benefit.
 *
 * Bounded at four levels: renderers nest wrappers, but not indefinitely, and an unbounded
 * climb ends at `<body>`.
 */
export function climbToContainer(
  self: { area: number },
  ancestors: Ancestor[],
  max = 4
): number {
  let levels = 0;
  let area = self.area;
  for (const ancestor of ancestors.slice(0, max)) {
    if (ancestor.containsOther) break;
    // A 15% floor: a wrapper adding a pixel of padding is not the field container, and
    // treating it as one would make the outline jitter between renders.
    if (ancestor.area <= area * 1.15) break;
    area = ancestor.area;
    levels += 1;
  }
  return levels;
}
