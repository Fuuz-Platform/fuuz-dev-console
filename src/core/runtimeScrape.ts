/**
 * A **running** screen's elements, read from its own rendered DOM.
 *
 * Highlighting worked in the designer and not at runtime, and the deeper reason was not
 * the locator: it was that at runtime there was no element list to hover in the first
 * place. The three existing sources are all designer- or API-shaped —
 *
 *   the design            needs a session token and a screen version
 *   the canvas scrape     needs `#mfgx-screen-designer-canvas`
 *   the structure tree    is a designer widget (and was accidentally matching the
 *                         Application Designer's module navigator instead)
 *
 * — so on a run route the Screen tab was empty or, worse, listed navigation rows that
 * could never highlight.
 *
 * This reads the rendered screen instead. That has a property none of the others do:
 * **every name here came out of the DOM, so the locator can always find it again.**
 * Highlighting works by construction rather than by a lookup that might miss.
 *
 * The trade-off is stated rather than hidden: only what is *currently rendered* appears.
 * A collapsed tab's contents, a dialog that is not open, a row not yet scrolled into a
 * virtualised table — none of those are in the DOM, so none are here.
 *
 * Pure — takes a root node, touches nothing.
 */

export interface RuntimeNode {
  /** Craft node id where the runtime exposes one, else the derived name. */
  nodeId: string;
  name: string;
  type: string;
  label?: string;
  /** The bound field path, for elements that bind one. */
  dataPath?: string;
  /** Which attribute the name came from, so a wrong guess is traceable. */
  via: string;
  children: RuntimeNode[];
  origin: 'runtime';
  /** Nothing here is anonymous by accident; false means we fell back to a type. */
  named: boolean;
  props: string[];
}

export interface RuntimeScrape {
  roots: RuntimeNode[];
  count: number;
  /**
   * Which marker attributes the page actually used.
   *
   * Reported because the attribute set is the one thing about the runtime that is not
   * documented anywhere — if Fuuz renames one, this says so instead of the tab quietly
   * going empty.
   */
  probe: { attributes: string[]; matched: number };
}

/**
 * Attributes that mark a rendered Fuuz element, most reliable first.
 *
 * `data-screen-element` and `data-system-name` are the designer's; the rest are what a
 * running screen emits. All are checked, because the runtime marks different element
 * kinds differently — a form field carries `formelement`, a container carries an id.
 */
const NAME_ATTRS = ['data-system-name', 'data-element-name', 'data-fuuz-element', 'formelement'];
const TYPE_ATTRS = ['data-screen-element', 'element'];
const PATH_ATTRS = ['field', 'data-data-path'];
const LABEL_ATTRS = ['data-label', 'aria-label'];

const MARKER = [...NAME_ATTRS, ...TYPE_ATTRS, ...PATH_ATTRS]
  .map((a) => `[${a}]`)
  .join(',');

/**
 * Whether an attribute value is a usable name.
 *
 * The runtime interpolates objects into attributes, so `field="[object Object]"` is a real
 * value on a real screen — and it became an element called `[object Object]`, which is
 * neither locatable nor meaningful. Junk is rejected rather than displayed, because a tree
 * full of `[object Object]` reads as the extension being broken.
 */
export function usableName(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v || v.length > 120) return false;
  if (v === '[object Object]' || v.startsWith('[object ')) return false;
  if (v === 'undefined' || v === 'null' || v === 'NaN') return false;
  // A serialised structure is a value, never a name.
  return !/^[[{]/.test(v);
}

/** Our own overlays, which must never appear as screen elements. */
const OURS = ['__fuuz_devtool_overlay', 'fuuz-dev-console-host', '__fuuz_markup_layer', '__fuuz_markup_bar'];

const first = (el: Element, attrs: string[]): { value: string; attr: string } | undefined => {
  for (const attr of attrs) {
    const value = el.getAttribute(attr);
    if (value) return { value, attr };
  }
  return undefined;
};

export interface ScrapeOptions {
  /**
   * Subtrees to skip — Fuuz's own console drawers, chiefly.
   *
   * Turning on transform debugging *opens the platform's console drawer*, whose controls are
   * built from the same components a screen is. So `defaultLogFilters` appeared in the
   * element list and then could not be highlighted, because it is not part of the screen at
   * all: it is a side effect of the diagnostics we ourselves switched on.
   */
  exclude?: Element[];
}

export function scrapeRuntime(root: ParentNode, options: ScrapeOptions = {}): RuntimeScrape | undefined {
  const excluded = options.exclude ?? [];
  const all = Array.from(root.querySelectorAll(MARKER))
    .filter((el) => !OURS.some((id) => el.id === id || el.closest?.(`#${id}`)))
    .filter((el) => !excluded.some((skip) => skip === el || skip.contains(el)));
  if (!all.length) return undefined;

  const attributes = new Set<string>();
  /*
   * Elements keyed by node, so containment can build the tree in one pass.
   *
   * A Map rather than a WeakMap: the order of insertion is document order, which is the
   * order the developer sees on screen, and reading it back out is how the roots are found.
   */
  const byElement = new Map<Element, RuntimeNode>();

  for (const el of all) {
    const named = first(el, NAME_ATTRS);
    const typed = first(el, TYPE_ATTRS);
    const path = first(el, PATH_ATTRS);
    const label = first(el, LABEL_ATTRS);
    for (const a of [named, typed, path, label]) if (a) attributes.add(a.attr);

    /*
     * A name, or nothing.
     *
     * **A bound path is not a name.** `data-data-path="assetCollection"` marks a wrapper
     * around a data-bound element; treating it as an element produced rows called
     * `assetCollection` and `title` that owned the real element as a *child* — the tree
     * inverted, with the binding parenting the thing that was bound.
     *
     * So an element must name itself: a name attribute, or a DOM id (which containers use).
     * A path-only node is a wrapper, and its path is attached to the element inside it.
     */
    const idName = /^[A-Za-z][\w-]*$/.test(el.id) ? el.id : '';
    const nameSource = usableName(named?.value) ? named : undefined;
    const name = nameSource?.value || idName || (usableName(typed?.value) ? typed!.value : '');
    if (!name) continue;

    const via = nameSource?.attr ?? (idName ? 'id' : typed?.attr ?? 'unknown');
    /*
     * The bound path, from this element or the wrapper around it.
     *
     * The pair (name, path) is what makes a field unique: two inputs on one form both carry
     * `formelement="AssetIntakeForm"`, and only the path tells them apart — which is also
     * exactly what the locator needs to outline the right one.
     */
    const boundPath = (path && usableName(path.value) ? path.value : undefined)
      ?? enclosingPath(el);

    byElement.set(el, {
      nodeId: el.getAttribute('data-node-id') || `${name}@${boundPath ?? via}`,
      name,
      type: usableName(typed?.value) ? typed!.value : 'Unknown',
      label: usableName(label?.value) ? label!.value : undefined,
      dataPath: boundPath,
      via,
      children: [],
      origin: 'runtime',
      // A name that is really a *type* is not this element's own name, and the tree marks
      // those so they read as approximate rather than authored.
      named: !!nameSource || !!idName,
      props: [],
    });
  }

  // Containment: the nearest scraped ancestor is the parent. Walking upward is O(depth)
  // per node and needs no sorting, unlike comparing every pair.
  const roots: RuntimeNode[] = [];
  for (const [el, node] of byElement) {
    let parent: Element | null = el.parentElement;
    while (parent && !byElement.has(parent)) parent = parent.parentElement;
    if (parent) byElement.get(parent)!.children.push(node);
    else roots.push(node);
  }

  return {
    roots,
    count: byElement.size,
    probe: { attributes: [...attributes].sort(), matched: all.length },
  };
}

/**
 * The bound path from the nearest wrapper above this element.
 *
 * A data-bound field is rendered as a wrapper carrying `data-data-path` around a control
 * carrying `formelement`. The path belongs to the field, so it is read from wherever it
 * sits rather than being lost because it was one level up.
 *
 * Bounded, so an unrelated path far above is not attributed to this element.
 */
function enclosingPath(el: Element, levels = 3): string | undefined {
  let parent = el.parentElement;
  for (let i = 0; parent && i < levels; i += 1, parent = parent.parentElement) {
    for (const attr of PATH_ATTRS) {
      const value = parent.getAttribute(attr);
      if (value && usableName(value)) return value;
    }
  }
  return undefined;
}

