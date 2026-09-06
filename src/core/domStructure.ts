/**
 * The screen structure, read from the designer's own tree widget.
 *
 * The App Designer already computes and renders exactly what we want — and
 * labels every row with its **craft node id** (`data-node-id="IntakePage00"`),
 * the same key used by `design.components[].props.design`. So in the designer we
 * do not have to guess, and we do not have to resolve a screen version through
 * the API before showing anything.
 *
 * This is a *fallback and a cross-check*, not a replacement for the design:
 *
 * - The tree is **lazy**. A collapsed row renders no children at all, so a scrape
 *   sees only what the developer has opened. `childCount` (from the row's own
 *   "N app components" label) is how we know something is missing rather than
 *   absent — the difference between "no children" and "children not shown".
 * - The tree is **filtered**. The designer's own filter chips hide rows, and when
 *   they hide everything it prints "Nothing matches the selected filters." Both
 *   states are reported so the panel never presents a truncated tree as complete.
 *
 * Pure — takes a root element, touches nothing.
 */

import { splitNameAndLabel } from './elementNames';

/** MUI v4 emits these unhashed; the `jssNNN` siblings are per-build and useless. */
const TREE = 'ul[role="tree"]';

/**
 * Rows the Application Designer's **module navigator** produces.
 *
 * That navigator is also a MUI TreeView, so `querySelector('ul[role="tree"]')` found it
 * first and the panel presented the app's module list — `module-group-materialsManagement`,
 * `DataModel-Product` — as though it were a screen's elements. Every one of them then
 * failed to highlight, because they are not screen elements at all: they are navigation.
 *
 * These prefixes are how the navigator names its rows, and they are unambiguous.
 */
const NAV_ROW = /^(module-group-|module-|component-type-|DataModel-|DataFlow-|Screen-|SavedTransform-)/;
const ITEM = 'li[role="treeitem"]';
const CONTENT = 'MuiTreeItem-content';
const LABEL = 'MuiTreeItem-label';
const GROUP = 'ul[role="group"]';
const SELECTED = 'Mui-selected';

/** The filter chips' icons, which are the only clue to a row's category. */
/**
 * The tree that holds a *screen's* elements, not the app's modules.
 *
 * Both are `ul[role="tree"]`, so the choice has to be made on content. A screen's
 * structure tree carries craft node ids on its rows and does not use the navigator's
 * row-name prefixes; the navigator is the opposite on both counts. Checking both is
 * deliberate — either alone would pick the wrong tree on some page.
 *
 * Returning undefined when only the navigator is present is the correct answer: there is
 * no screen structure on that page, and an empty Screen tab is far better than one
 * listing modules that can never highlight.
 */
function screenStructureTree(root: ParentNode): Element | undefined {
  const trees = Array.from(root.querySelectorAll(TREE));
  const scored = trees.map((tree) => {
    const items = Array.from(tree.querySelectorAll(ITEM));
    const nav = items.filter((li) => NAV_ROW.test(rowName(li))).length;
    const withNodeId = items.filter((li) => li.hasAttribute('data-node-id')).length;
    return { tree, items: items.length, nav, withNodeId };
  });
  // A tree whose rows are mostly navigator rows is the navigator, whatever else it has.
  const candidates = scored.filter((s) => s.items > 0 && s.nav < s.items / 2);
  if (!candidates.length) return undefined;
  // Among the rest, the one that actually carries craft ids.
  return candidates.sort((a, b) => b.withNodeId - a.withNodeId || b.items - a.items)[0].tree;
}

/** A row's own name, without descending into its children's labels. */
function rowName(item: Element): string {
  const label = item.querySelector(`.${LABEL} div[title]`)?.getAttribute('title')
    ?? item.querySelector(`.${LABEL}`)?.textContent
    ?? '';
  return label.trim();
}

const CATEGORY_BY_ICON: Record<string, string> = {
  'vector-square': 'Layout',
  'file-lines': 'Data',
  keyboard: 'Input',
  'chart-pie': 'Display',
  'arrow-pointer': 'Buttons',
};

/**
 * Badges the designer paints on a row when a prop is in use.
 *
 * Free information about which elements are worth looking at — an element whose
 * visibility or disabled state is driven by a transform is exactly where screen
 * bugs live, and the designer has already worked it out.
 */
const BADGE_BY_ICON: Record<string, string> = {
  'code-simple': 'scripts',
  'eye-slash': 'visibility',
  ban: 'disabled',
};

export interface DomStructureNode {
  /** Craft node id — joins straight to the design graph. Not the element name. */
  nodeId: string;
  /** The element name alone, with any trailing `(Label)` stripped. */
  name: string;
  /** The label the designer appended to the name, when there was one. */
  label?: string;
  /** Props the designer flags as in use: visibility, disabled, scripts. */
  badges: string[];
  /** Broad element family, inferred from the row icon. Not the resolved type. */
  category?: string;
  /** Children the row claims to have, from its own count label. */
  childCount?: number;
  /** false = collapsed, so `children` is empty but not necessarily childless. */
  expanded: boolean;
  /** The row the developer has selected in the designer. */
  selected: boolean;
  children: DomStructureNode[];
}

export interface DomStructureResult {
  roots: DomStructureNode[];
  /** Rows whose children the tree has not rendered, so the scrape is partial. */
  collapsed: number;
  /** The designer's filters are hiding every row. */
  filteredEmpty: boolean;
  /** Total rows read. */
  count: number;
}

/** Elements matching `selector` whose nearest enclosing tree item is `owner`. */
function ownItems(scope: Element, owner: Element | null): Element[] {
  return Array.from(scope.querySelectorAll(ITEM)).filter(
    (el) => el.parentElement?.closest(ITEM) === owner
  );
}

/** A tree item's own content row — never a nested item's. */
function ownContent(item: Element): Element | undefined {
  return Array.from(item.children).find((c) => c.classList.contains(CONTENT));
}

function readCount(label: Element): number | undefined {
  // Rendered as `<p title="10 app components">10</p>`.
  for (const p of Array.from(label.querySelectorAll('p[title]'))) {
    const m = p.getAttribute('title')?.match(/^(\d+)\s/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function readName(label: Element, fallback: string): { name: string; label?: string } {
  // The name sits on a wrapper `div[title="IntakePage"]`; sibling controls carry
  // titles too ("Quick actions", "10 app components"), so take the first *div*.
  const titled = label.querySelector('div[title]');
  const title = titled?.getAttribute('title')?.trim() || titled?.textContent?.trim();
  return title ? splitNameAndLabel(title) : { name: fallback };
}

/** Prop badges on this row — visibility, disabled, scripts. */
function readBadges(label: Element): string[] {
  const out = new Set<string>();
  for (const svg of Array.from(label.querySelectorAll('svg[data-icon]'))) {
    const badge = BADGE_BY_ICON[svg.getAttribute('data-icon') ?? ''];
    if (badge) out.add(badge);
  }
  return [...out];
}

function readCategory(label: Element): string | undefined {
  const icon = label.querySelector('svg[data-icon]')?.getAttribute('data-icon');
  return icon ? CATEGORY_BY_ICON[icon] : undefined;
}

function parseItem(item: Element, tally: { collapsed: number; count: number }, depth: number): DomStructureNode | undefined {
  const nodeId = item.getAttribute('data-node-id');
  if (!nodeId || depth > 24) return undefined;
  tally.count += 1;

  const content = ownContent(item);
  const label = content?.getElementsByClassName(LABEL)[0];
  const expanded = item.getAttribute('aria-expanded') === 'true';
  const childCount = label ? readCount(label) : undefined;

  const group = Array.from(item.children).find((c) => c.matches(GROUP));
  const children = group
    ? ownItems(group, item)
        .map((c) => parseItem(c, tally, depth + 1))
        .filter((c): c is DomStructureNode => !!c)
    : [];

  // A row that claims children but rendered none is hiding them behind a chevron.
  if (!children.length && (childCount ?? 0) > 0 && !expanded) tally.collapsed += 1;

  const named: { name: string; label?: string } = label ? readName(label, nodeId) : { name: nodeId };
  return {
    nodeId,
    name: named.name,
    label: named.label,
    badges: label ? readBadges(label) : [],
    category: label ? readCategory(label) : undefined,
    childCount,
    expanded,
    selected: item.classList.contains(SELECTED),
    children,
  };
}

/**
 * Read the designer's structure tree out of `root` (a document or any container).
 * Returns undefined when no tree is present — i.e. we are not in the designer.
 */
export function parseDomStructure(root: ParentNode): DomStructureResult | undefined {
  const tree = screenStructureTree(root);
  if (!tree) return undefined;

  const tally = { collapsed: 0, count: 0 };
  const roots = ownItems(tree, null)
    .map((item) => parseItem(item, tally, 0))
    .filter((n): n is DomStructureNode => !!n);

  return {
    roots,
    collapsed: tally.collapsed,
    filteredEmpty: /Nothing matches the selected filters/i.test(tree.textContent ?? ''),
    count: tally.count,
  };
}

/** The craft node the developer currently has selected, if any. */
export function selectedNode(result: DomStructureResult | undefined): DomStructureNode | undefined {
  const walk = (nodes: DomStructureNode[]): DomStructureNode | undefined => {
    for (const n of nodes) {
      // A selected parent stays selected while a child is chosen, so prefer the
      // deepest match — that is the row the developer actually clicked.
      const deeper = walk(n.children);
      if (deeper) return deeper;
      if (n.selected) return n;
    }
    return undefined;
  };
  return walk(result?.roots ?? []);
}

/**
 * Adapt to the design-derived shape the panel already renders.
 *
 * Everything the design would supply — resolved type, dynamic props, bound
 * field, style object — is genuinely unknown here, and is left empty rather
 * than guessed. `origin` is what lets the panel say so instead of showing an
 * element as having no transforms when it has simply never been asked.
 */
export function toStructureNodes(nodes: DomStructureNode[]): import('./structure').StructureNode[] {
  return nodes.map((n) => ({
    nodeId: n.nodeId,
    name: n.name,
    label: n.label,
    // Every row in the designer tree is one the author placed and named.
    named: true,
    type: n.category ?? 'Unknown',
    // The designer's badges are the one prop fact the scrape *does* know, so
    // they are reported rather than thrown away — an element whose visibility is
    // driven by a transform is exactly what you came looking for.
    props: n.badges,
    stylable: false,
    origin: 'designer-dom' as const,
    unrendered: !n.children.length && (n.childCount ?? 0) > 0 ? n.childCount : undefined,
    children: toStructureNodes(n.children),
  }));
}

/**
 * One line describing how complete the scrape is.
 *
 * The panel must say this out loud. A tree that silently omits collapsed or
 * filtered rows would have the developer chasing an element that is right there.
 */
export function completeness(result: DomStructureResult): string {
  if (result.filteredEmpty) return 'the designer’s filters are hiding every element';
  const parts: string[] = [`${result.count} element${result.count === 1 ? '' : 's'}`];
  if (result.collapsed) parts.push(`${result.collapsed} collapsed (children not rendered)`);
  return parts.join(' · ');
}
