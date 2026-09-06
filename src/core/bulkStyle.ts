/**
 * Restyling every element of one kind at once.
 *
 * Setting the corner radius on seven action buttons means opening seven property panels and
 * making the same edit seven times — and getting one of them wrong is invisible until someone
 * notices the odd button. The elements are already grouped by type in the tree; the work is
 * offering the *right* properties per group and applying to all of them together.
 *
 * ## What "the right properties" means
 *
 * Offering all twenty CSS properties for every group would recreate the problem this solves. A
 * container has no icon and no font of its own; a button has no `gap`. So each group gets the
 * properties that make sense for its kind, and the categories come from what the element
 * actually is rather than from one flat list.
 *
 * ## What this does not do
 *
 * It writes to the **DOM**, so the next render overwrites it. Reaching the saved screen
 * definition needs the application service, which is switched off in this build — so this is a
 * preview of a design change, not the change. Said in the pane rather than left to be
 * discovered when a reload loses the work.
 *
 * Pure.
 */
import type { StructureNode } from './structure';

export interface StyleField {
  /** The CSS property, as `element.style` takes it. */
  css: string;
  label: string;
  /** How to edit it, so a colour gets a colour picker and a radius a number. */
  kind: 'length' | 'colour' | 'number' | 'text' | 'choice';
  /** Members, for a `choice`. */
  options?: string[];
  placeholder?: string;
}

const LENGTH = (css: string, label: string, placeholder = '8px'): StyleField =>
  ({ css, label, kind: 'length', placeholder });
const COLOUR = (css: string, label: string): StyleField => ({ css, label, kind: 'colour' });

/**
 * Properties that apply to anything with a box — which is everything.
 *
 * Size, spacing and the border are the edits people actually make in bulk: "all the buttons
 * are too tall", "the cards need more padding".
 */
const BOX: StyleField[] = [
  LENGTH('width', 'Width', 'auto'),
  LENGTH('height', 'Height', 'auto'),
  LENGTH('min-height', 'Min height'),
  LENGTH('padding', 'Padding'),
  LENGTH('margin', 'Margin'),
  LENGTH('border-radius', 'Corner radius', '4px'),
  { css: 'border', label: 'Border', kind: 'text', placeholder: '1px solid #ccc' },
  COLOUR('background-color', 'Background'),
  { css: 'opacity', label: 'Opacity', kind: 'number', placeholder: '1' },
];

/** Anything that renders text of its own. */
const TEXT: StyleField[] = [
  COLOUR('color', 'Text colour'),
  LENGTH('font-size', 'Font size', '14px'),
  {
    css: 'font-weight', label: 'Font weight', kind: 'choice',
    options: ['400', '500', '600', '700'],
  },
  {
    css: 'text-align', label: 'Text align', kind: 'choice',
    options: ['left', 'center', 'right'],
  },
  { css: 'text-transform', label: 'Text transform', kind: 'choice', options: ['none', 'uppercase', 'capitalize'] },
];

/** Layout, which only means something for something that lays children out. */
const LAYOUT: StyleField[] = [
  { css: 'display', label: 'Display', kind: 'choice', options: ['block', 'flex', 'inline-flex', 'grid', 'none'] },
  { css: 'flex-direction', label: 'Direction', kind: 'choice', options: ['row', 'column'] },
  LENGTH('gap', 'Gap'),
  {
    css: 'align-items', label: 'Align items', kind: 'choice',
    options: ['flex-start', 'center', 'flex-end', 'stretch'],
  },
  {
    css: 'justify-content', label: 'Justify', kind: 'choice',
    options: ['flex-start', 'center', 'flex-end', 'space-between'],
  },
  { css: 'overflow', label: 'Overflow', kind: 'choice', options: ['visible', 'hidden', 'auto', 'scroll'] },
];

/**
 * Icon sizing, which is set on the icon rather than the element.
 *
 * `font-size` on a button changes its label; an icon font takes its size from its own element.
 * Applying it to the button would silently do the wrong thing, so it is a separate field with a
 * descendant selector — and only offered where there is an icon.
 */
const ICON: StyleField[] = [
  { css: 'svg:font-size', label: 'Icon size', kind: 'length', placeholder: '20px' },
  { css: 'svg:color', label: 'Icon colour', kind: 'colour' },
];

const isButton = (type: string) => /Button$|^Action/i.test(type);
const isInput = (type: string) => /Input$|^Switch$|^ScanText/i.test(type);
const isContainer = (type: string) => /^(Container|Card|Page|Screen|Grid|Stack|Layout|Tabs?)$/i.test(type);
const isTable = (type: string) => /^(Table|DataGrid|List|DataTree)$/i.test(type);
const isText = (type: string) => /^(Text|Label|Heading|Markdown|Typography)/i.test(type);

/**
 * The style fields worth offering for an element type.
 *
 * Unknown types get box plus text: the safe superset, since we cannot say an undocumented
 * element has no font — and offering nothing would make the group useless.
 */
export function styleFieldsFor(type: string): StyleField[] {
  if (isButton(type)) return [...BOX, ...TEXT, ...ICON];
  if (isInput(type)) return [...BOX, ...TEXT, ...ICON];
  if (isContainer(type)) return [...BOX, ...LAYOUT];
  if (isTable(type)) return [...BOX, ...TEXT, ...LAYOUT];
  if (isText(type)) return [...TEXT, LENGTH('margin', 'Margin'), LENGTH('padding', 'Padding')];
  return [...BOX, ...TEXT];
}

export interface TypeGroup {
  type: string;
  /** Every element of this type under the chosen root, in tree order. */
  elements: { name: string; type: string; dataPath?: string; label?: string }[];
  fields: StyleField[];
}

/**
 * Elements under a root, grouped by type.
 *
 * The root is normally a page container — a screen can hold several, and "all the buttons"
 * usually means all the buttons *on this page* rather than across the whole screen. Passing the
 * screen root gives the wider answer, which is why the caller chooses.
 *
 * Unnamed elements are skipped: they cannot be located in the page, so applying to them would
 * silently do nothing and inflate the count.
 */
export function groupByType(root: StructureNode | undefined, all: StructureNode[]): TypeGroup[] {
  const scope = root ? [root] : all;
  const byType = new Map<string, TypeGroup['elements']>();

  const walk = (nodes: StructureNode[]) => {
    for (const node of nodes) {
      if (node.name && node.type && node.type !== 'Unknown') {
        const list = byType.get(node.type);
        const entry = { name: node.name, type: node.type, dataPath: node.dataPath, label: node.label };
        if (list) list.push(entry);
        else byType.set(node.type, [entry]);
      }
      walk(node.children ?? []);
    }
  };
  walk(scope);

  return [...byType.entries()]
    .map(([type, elements]) => ({ type, elements, fields: styleFieldsFor(type) }))
    // Biggest groups first: they are where a bulk edit pays off, and a group of one is not
    // really a bulk edit at all.
    .sort((a, b) => b.elements.length - a.elements.length || a.type.localeCompare(b.type));
}

/**
 * Containers that could serve as a root — the "pages" of a screen.
 *
 * A screen's own top-level containers, which is what someone means by "this page". Deliberately
 * not every container: nesting three levels of `Card` into the list would bury the two that are
 * actually pages.
 */
export function pageRoots(all: StructureNode[]): StructureNode[] {
  const roots = all.filter((n) => n.name && isContainer(n.type ?? ''));
  if (roots.length) return roots;
  // A screen whose root is not a container still has a root, and scoping to it is better than
  // offering nothing.
  return all.filter((n) => n.name);
}

/**
 * Turn the edited fields into the CSS to apply, per element.
 *
 * Empty fields are dropped rather than applied as empty strings: an empty string *clears* a CSS
 * property, so sending every untouched field would wipe the element's own styling — the exact
 * opposite of what a bulk edit of two properties should do.
 *
 * `svg:` fields are returned separately, because they target a descendant and the caller has to
 * apply them differently.
 */
export function buildEdit(fields: StyleField[], values: Record<string, string>): {
  own: Record<string, string>;
  descendant: { selector: string; css: Record<string, string> }[];
} {
  const own: Record<string, string> = {};
  const bySelector = new Map<string, Record<string, string>>();

  for (const field of fields) {
    const value = (values[field.css] ?? '').trim();
    if (!value) continue;
    const [selector, prop] = field.css.includes(':') ? field.css.split(':') : ['', field.css];
    if (!selector) { own[prop] = value; continue; }
    const bag = bySelector.get(selector) ?? {};
    bag[prop] = value;
    bySelector.set(selector, bag);
  }

  return {
    own,
    descendant: [...bySelector.entries()].map(([selector, css]) => ({ selector, css })),
  };
}

/** How many properties an edit would set — for the confirm label. */
export const editSize = (edit: ReturnType<typeof buildEdit>) =>
  Object.keys(edit.own).length + edit.descendant.reduce((n, d) => n + Object.keys(d.css).length, 0);
