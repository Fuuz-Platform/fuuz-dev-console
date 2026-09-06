/**
 * The element tree, read from the designer canvas itself.
 *
 * This is the best structure source available, and it took three worse attempts
 * to find it. The canvas renders every element as a wrapper div carrying both
 * its **type** and its **name**:
 *
 *     div[data-screen-element="Container"][data-system-name="IntakeFieldStack"]
 *       └ div#IntakeFieldStack  style="padding:8px; display:flex; …"
 *           └ div[data-screen-element="TextInput"][data-system-name="IntakeTitle"]
 *               └ div[data-label="Title"][data-data-path="title"]
 *                   └ div[formelement="AssetIntakeForm"][field="title"][description="…"]
 *
 * Why it beats the alternatives:
 *
 *  - **The Screen Structure widget is lazy and filterable.** A collapsed row
 *    renders no children and the filter chips can hide everything, so a scrape
 *    of it is always possibly-partial and has to say so. The canvas renders the
 *    whole screen.
 *  - **The API fetch needs a screen version**, and in the designer the runtime
 *    context has none — the fallback is a tab id that may not be a screen id.
 *  - The canvas also carries the **applied CSS** and the **bound field**, which
 *    neither of the others do.
 *
 * What it does not carry is the JSONata behind a prop. Transforms still come
 * from the design or from the captured log; a `style` attribute is the *result*
 * of a transform, never the expression.
 *
 * Pure — takes a root, touches nothing.
 */
import type { StructureNode } from './structure';

/** Set by the renderer on every element wrapper. */
const ELEMENT = '[data-screen-element][data-system-name]';

/**
 * Attributes the renderer spreads onto a field's inner div.
 *
 * These are React props leaking into the DOM, which is exactly what makes them
 * useful: `description` and `field` are authored values with no other source
 * outside the design.
 */
const PROP_ATTRS = ['formelement', 'field', 'description', 'element', 'placeholder', 'variant', 'height'];

/** `[object Object]` means the renderer stringified a prop — present but unreadable. */
const OPAQUE = '[object Object]';

export interface CanvasElement extends Omit<StructureNode, 'children'> {
  children: CanvasElement[];
  /** Inline styles the renderer applied — the computed result of the design. */
  css: Record<string, string>;
  /** Authored prop values recovered from DOM attributes. */
  attrs: Record<string, string>;
  /** Props present but stringified by React, so known-to-exist only. */
  opaqueProps: string[];
}

/** Parse a `style` attribute into declarations. */
function parseStyle(value: string | null): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const part of value.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const prop = part.slice(0, at).trim();
    const val = part.slice(at + 1).trim();
    if (prop && val) out[prop] = val;
  }
  return out;
}

/** Elements whose nearest enclosing element wrapper is `owner`. */
function ownElements(scope: Element, owner: Element | null): Element[] {
  return Array.from(scope.querySelectorAll(ELEMENT)).filter(
    (el) => el.parentElement?.closest(ELEMENT) === owner
  );
}

/**
 * The div holding this element's real layout.
 *
 * The wrapper positions the element; the inner `#<name>` div carries what the
 * author actually set — padding, margin, flex direction. Taking the wrapper's
 * style would report the renderer's positioning as the developer's design.
 */
function innerFor(wrapper: Element, name: string): Element | undefined {
  const byId = name && /^[A-Za-z][\w-]*$/.test(name)
    ? Array.from(wrapper.children).find((c) => c.id === name)
    : undefined;
  if (byId) return byId;
  // Inputs wrap their field in a div carrying the label and bound path instead.
  const field = wrapper.querySelector('[data-data-path],[data-label]');
  return field && field.closest(ELEMENT) === wrapper ? field : undefined;
}

function collectAttrs(wrapper: Element): { attrs: Record<string, string>; opaque: string[] } {
  const attrs: Record<string, string> = {};
  const opaque = new Set<string>();
  // Scan the element's own subtree, stopping at nested elements so a child's
  // props are never reported as the parent's.
  const scan = (el: Element) => {
    for (const name of PROP_ATTRS) {
      const value = el.getAttribute(name);
      if (value === null || name in attrs) continue;
      if (value === OPAQUE) opaque.add(name);
      else if (value !== '') attrs[name] = value;
    }
    // Anything else stringified is still worth naming as present.
    for (const attr of Array.from(el.attributes)) {
      if (attr.value === OPAQUE) opaque.add(attr.name);
    }
    for (const child of Array.from(el.children)) {
      if (child.matches(ELEMENT)) continue;
      scan(child);
    }
  };
  scan(wrapper);
  return { attrs, opaque: [...opaque].sort() };
}

function parseElement(wrapper: Element, depth: number): CanvasElement | undefined {
  if (depth > 24) return undefined;
  const type = wrapper.getAttribute('data-screen-element') ?? 'Unknown';
  const name = wrapper.getAttribute('data-system-name') ?? '';
  if (!name) return undefined;

  const inner = innerFor(wrapper, name);
  const { attrs, opaque } = collectAttrs(wrapper);
  const labelled = wrapper.querySelector('[data-label]');
  const pathed = wrapper.querySelector('[data-data-path]');

  const children = ownElements(wrapper, wrapper)
    .map((c) => parseElement(c, depth + 1))
    .filter((c): c is CanvasElement => !!c);

  const css = { ...parseStyle(wrapper.getAttribute('style')), ...parseStyle(inner?.getAttribute('style') ?? null) };

  return {
    // The canvas has no craft ids, so the name is the identity — it is unique
    // within a screen and is what every other view keys on.
    nodeId: `canvas:${name}`,
    name,
    named: true,
    type,
    // Only props with a transform belong here, and the DOM never shows those.
    props: [],
    dataPath: pathed?.closest(ELEMENT) === wrapper ? pathed.getAttribute('data-data-path') ?? undefined : undefined,
    label: labelled?.closest(ELEMENT) === wrapper ? labelled.getAttribute('data-label') ?? undefined : undefined,
    style: css,
    stylable: Object.keys(css).length > 0,
    origin: 'canvas',
    children,
    css,
    attrs,
    opaqueProps: opaque,
  };
}

export interface CanvasScrape {
  roots: CanvasElement[];
  count: number;
  /** The element the designer currently has selected, if it marks one. */
  selected?: string;
}

/**
 * Read the canvas. Returns undefined when no element wrappers are present —
 * i.e. this is not a screen designer, or the canvas has not rendered.
 */
export function scrapeCanvas(root: ParentNode): CanvasScrape | undefined {
  const all = root.querySelectorAll(ELEMENT);
  if (!all.length) return undefined;

  const roots = ownElements(root as unknown as Element, null)
    .map((el) => parseElement(el, 0))
    .filter((n): n is CanvasElement => !!n);
  if (!roots.length) return undefined;

  // The designer marks its selection on the structure tree, not the canvas, so
  // read it from there — it is the one thing the tree knows that this does not.
  const selectedRow = root.querySelector('li[role="treeitem"][aria-selected="true"][data-node-id]');
  const selectedName = selectedRow
    ?.querySelector('.MuiTreeItem-label div[title]')
    ?.getAttribute('title')
    ?.replace(/\s+\(.*\)$/, '')
    ?.trim();

  const count = (function tally(ns: CanvasElement[]): number {
    return ns.reduce((n, c) => n + 1 + tally(c.children), 0);
  })(roots);

  return { roots, count, selected: selectedName || undefined };
}

/** Flatten for search and rendering. */
export function flattenCanvas(nodes: CanvasElement[], depth = 0): { node: CanvasElement; depth: number }[] {
  return nodes.flatMap((n) => [{ node: n, depth }, ...flattenCanvas(n.children, depth + 1)]);
}
