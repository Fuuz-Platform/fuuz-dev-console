/**
 * Organising one element's properties so they can be read.
 *
 * The platform's own panel for a single `SelectInput` runs to roughly 7,600 pixels: every
 * section expanded, every property present whether or not it is set, four separate blocks
 * all labelled "Advanced" with identical `Fallback Value` / `Dynamic Fields` / `Cache Key`
 * children, and an inline field picker several hundred pixels tall. Everything is *there*,
 * and nothing is findable.
 *
 * That panel has to be exhaustive — it is where you author. This one does not: it is where
 * you find out what is true. So it is organised around the questions actually being asked,
 * and four decisions follow from that:
 *
 *  1. **Set properties first, and alone by default.** Of ~60 documented properties a real
 *     element sets a dozen. The rest are empty rows burying the ones that matter, so they
 *     move behind a switch that says how many it is hiding.
 *  2. **Problems above properties, and only when there are some.** An unresolved read or a
 *     transform with no cache key is why you opened the panel; an empty "Issues" heading is
 *     noise.
 *  3. **Provenance on every row.** Whether a value was authored, computed by a transform,
 *     read from the runtime, or is just the documented default — this is the one thing the
 *     authoring panel cannot tell you, and usually the answer.
 *  4. **The platform's own section names are kept**, collapsed, so a developer who is
 *     looking at Fuuz's "Behavior" group can find the same properties here. Reorganising
 *     into better categories would be cleaner and would break that mapping.
 *
 * Pure.
 */
import type { PropertyRow } from './propertyModel';

/** Where a property's current value came from. The most useful column in the panel. */
export type Provenance = 'transform' | 'authored' | 'runtime' | 'default' | 'unset' | 'unknown';

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  transform: 'ƒx',
  authored: 'set',
  runtime: 'live',
  default: 'default',
  unset: '—',
  unknown: '?',
};

export const PROVENANCE_TITLE: Record<Provenance, string> = {
  transform: 'Computed by a transform on this element',
  authored: 'A literal value set in the designer',
  runtime: 'Held by the runtime — not in the design',
  default: 'The documented default; nothing sets it',
  unset: 'No value, and no documented default',
  unknown: 'Undocumented for this element type — unknown, not none',
};

/**
 * Where a property's value came from.
 *
 * `dynamic` is unambiguous — a transform produced it. Beyond that the distinction that
 * matters is **set versus defaulted**: a value equal to its documented default is almost
 * always nobody having touched it, and showing that as "set" makes fifty untouched
 * properties look deliberate.
 */
export function provenanceOf(row: PropertyRow): Provenance {
  if (row.state === 'dynamic') return 'transform';
  if (row.state === 'unknown') return row.hasValue ? 'runtime' : 'unknown';
  if (!row.hasValue) return row.defaultValue !== undefined ? 'default' : 'unset';
  if (row.defaultValue !== undefined && sameAsDefault(row)) return 'default';
  return 'authored';
}

/** Whether the live value is indistinguishable from the documented default. */
function sameAsDefault(row: PropertyRow): boolean {
  const shown = String(row.defaultValue ?? '').trim().replace(/^["']|["']$/g, '');
  const value = row.value;
  if (value === null || value === undefined) return shown === '' || shown === 'null';
  if (typeof value === 'object') return false;
  return String(value) === shown;
}

/** True when this property has something worth reading — a value or a transform. */
export const isSet = (row: PropertyRow) => {
  const p = provenanceOf(row);
  return p === 'transform' || p === 'authored' || p === 'runtime';
};

/* ── Problems ─────────────────────────────────────────────────────────────── */

export interface PropertyProblem {
  property: string;
  /** Short, in the words the fix would use. */
  summary: string;
  severity: 'high' | 'medium';
}

/**
 * What is visibly wrong with this element's properties.
 *
 * Only from what the panel already holds — no new analysis, and nothing speculative. A
 * transform whose reads did not resolve is the highest-value finding available here,
 * because the symptom (a null where a value should be) points nowhere near the cause.
 */
export function problemsFor(
  rows: PropertyRow[],
  transforms: { writes: string; inputs: { path: string; resolved: boolean }[]; cacheKey?: string }[]
): PropertyProblem[] {
  const out: PropertyProblem[] = [];

  for (const t of transforms) {
    const property = t.writes.split('.').pop() ?? t.writes;
    const unresolved = t.inputs.filter((i) => !i.resolved);
    if (unresolved.length) {
      out.push({
        property,
        severity: 'high',
        summary: `reads ${unresolved.map((u) => u.path).join(', ')} — not found, so this evaluates against null`,
      });
    }
  }

  /*
   * A transform-bearing property whose value never materialised.
   *
   * The transform is declared and the property still has nothing, which means it either
   * never ran or returned undefined — different causes, same symptom, and both worth a look.
   */
  for (const row of rows) {
    if (row.state === 'dynamic' && !row.hasValue) {
      out.push({
        property: row.name,
        severity: 'medium',
        summary: 'has a transform but no value — it never ran, or returned nothing',
      });
    }
  }

  return out;
}

/* ── Grouping ─────────────────────────────────────────────────────────────── */

export interface PropertyGroup {
  /** The platform's own designer section, or a bucket for what it does not name. */
  title: string;
  rows: PropertyRow[];
  /** How many of these are actually set, for the collapsed heading. */
  set: number;
  /** Open on arrival. */
  open: boolean;
}

/**
 * Section order, following the platform's own panel.
 *
 * Kept in the designer's order rather than a "better" one: someone cross-referencing the two
 * panels should find the same properties in the same places. `Data` is lifted to the front
 * because a binding is what a diagnostic session almost always starts from.
 */
const SECTION_ORDER = ['Data', 'Basic', 'Display', 'Behavior', 'Validation', 'Advanced', 'System'];

/** Sections that arrive open, because they carry the properties people come for. */
const OPEN_BY_DEFAULT = new Set(['Data', 'Basic']);

const UNSECTIONED = 'Other';

export interface PanelView {
  groups: PropertyGroup[];
  problems: PropertyProblem[];
  counts: {
    total: number;
    set: number;
    transforms: number;
    /** Documented properties with nothing set — the number the "all" switch reveals. */
    hidden: number;
    problems: number;
  };
}

export interface PanelOptions {
  /** `set` shows only properties with a value or transform; `all` shows everything. */
  scope?: 'set' | 'all' | 'problems';
  /** Free-text filter over names, values, types, descriptions and expressions. */
  query?: string;
}

/**
 * Build the panel.
 *
 * Filtering happens before grouping so a section's heading count reflects what the developer
 * is actually looking at — a group labelled "8" that shows two rows is worse than no count.
 */
export function buildPanel(
  rows: PropertyRow[],
  transforms: { writes: string; inputs: { path: string; resolved: boolean }[]; cacheKey?: string }[] = [],
  options: PanelOptions = {}
): PanelView {
  const problems = problemsFor(rows, transforms);
  const problemProps = new Set(problems.map((p) => p.property));
  const scope = options.scope ?? 'set';
  const query = (options.query ?? '').trim().toLowerCase();

  const inScope = rows.filter((row) => {
    if (scope === 'problems') return problemProps.has(row.name);
    if (scope === 'set') return isSet(row);
    return true;
  });

  const matching = query ? inScope.filter((row) => matches(row, query)) : inScope;

  const bySection = new Map<string, PropertyRow[]>();
  for (const row of matching) {
    const key = row.section?.trim() || UNSECTIONED;
    const list = bySection.get(key);
    if (list) list.push(row);
    else bySection.set(key, [row]);
  }

  const groups: PropertyGroup[] = [...bySection.entries()]
    .map(([title, list]) => ({
      title,
      rows: list.slice().sort(byInterest),
      set: list.filter(isSet).length,
      /*
       * A search opens everything: hiding a match behind a collapsed heading is the one
       * outcome a search must never produce. Otherwise only the sections people come for.
       */
      open: !!query || scope === 'problems' || OPEN_BY_DEFAULT.has(title) || list.some((r) => r.state === 'dynamic'),
    }))
    .sort((a, b) => rank(a.title) - rank(b.title) || a.title.localeCompare(b.title));

  return {
    groups,
    problems,
    counts: {
      total: rows.length,
      set: rows.filter(isSet).length,
      transforms: rows.filter((r) => r.state === 'dynamic').length,
      hidden: rows.filter((r) => !isSet(r)).length,
      problems: problems.length,
    },
  };
}

const rank = (title: string) => {
  const at = SECTION_ORDER.indexOf(title);
  return at === -1 ? SECTION_ORDER.length : at;
};

/**
 * Within a section: transforms, then set values, then the rest, alphabetically.
 *
 * A transform is the most interesting thing a property can have — it is behaviour, not
 * configuration — so it sorts to the top of whatever group it is in.
 */
function byInterest(a: PropertyRow, b: PropertyRow): number {
  const weight = (r: PropertyRow) => (r.state === 'dynamic' ? 0 : isSet(r) ? 1 : 2);
  return weight(a) - weight(b) || a.name.localeCompare(b.name);
}

/**
 * Whether a row matches a search.
 *
 * Expressions are included deliberately: "which transform reads `$state.libraryId`" is a
 * real question, and the property name alone cannot answer it.
 */
function matches(row: PropertyRow, query: string): boolean {
  const haystack = [
    row.name, row.type, row.section ?? '', row.description ?? '',
    row.expression ?? '', row.hasValue ? summarise(row.value) : '',
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

/**
 * A value in one line.
 *
 * The platform's panel renders a nine-field picker as several hundred pixels of checkboxes
 * inline. A count you can expand tells you the same thing and leaves the rest of the element
 * visible.
 */
export function summarise(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 60)}…` : value;
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[ ${value.length} item${value.length === 1 ? '' : 's'} ]`;
  const keys = Object.keys(value as Record<string, unknown>);
  return `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? `, +${keys.length - 3}` : ''} }`;
}

/** Whether a value needs expanding to be read at all. */
export const isLarge = (value: unknown) =>
  value !== null && typeof value === 'object'
  && (Array.isArray(value) ? value.length > 0 : Object.keys(value as object).length > 0);
