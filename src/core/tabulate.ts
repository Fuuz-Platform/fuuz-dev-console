/**
 * Turning a GraphQL response into a table.
 *
 * A Fuuz query answers `{ data: { assetCollection: [ {…}, {…} ] } }` — the rows are
 * always nested somewhere under `data`, never at the top, and the nesting depth
 * differs per query. Reading twenty records as pretty-printed JSON means scrolling
 * past the same eight keys twenty times, which is why the spreadsheet view exists.
 *
 * Two problems have to be solved honestly:
 *
 *  - **Which array is the data?** A response can hold several. Guessing wrong shows
 *    a table of the wrong thing, so the choice is explicit, reported by path, and
 *    the caller can override it.
 *  - **Which columns?** Records are not uniform: GraphQL omits nulls, and one row
 *    having `notes` while another does not is normal. Taking the first row's keys
 *    would silently drop columns, so the union of all rows is used.
 *
 * Nested objects are flattened one level with dotted keys (`site.name`), because
 * that is how Fuuz relations come back and a column reading `[object Object]` is
 * useless. Deeper structures stay as JSON in the cell rather than exploding the
 * column count.
 *
 * Pure.
 */

export interface Table {
  columns: string[];
  /** Row values, aligned to `columns`; a missing key is undefined, not ''. */
  rows: unknown[][];
  /** Where the rows were found, e.g. `data.assetCollection`. */
  path: string;
  /** Other arrays in the response, so the caller can offer them. */
  alternatives: { path: string; count: number }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every array of objects in the response, with its path and length.
 *
 * Depth-limited: a response deep enough to exceed this is nested beyond what a
 * table would communicate anyway.
 */
export function findArrays(value: unknown, path = '', depth = 0): { path: string; count: number }[] {
  if (depth > 8 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    // An array of scalars is a list, not a table; it is still offered, because a
    // single-column table of ids is a legitimate thing to want.
    return value.length ? [{ path: path || '(root)', count: value.length }] : [];
  }
  const out: { path: string; count: number }[] = [];
  for (const [key, child] of Object.entries(value)) {
    out.push(...findArrays(child, path ? `${path}.${key}` : key, depth + 1));
  }
  return out;
}

/** Read a dotted path, tolerating anything missing. */
function at(value: unknown, path: string): unknown {
  if (path === '(root)') return value;
  let cursor: unknown = value;
  for (const key of path.split('.')) {
    if (!isRecord(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Flatten one record one level deep.
 *
 * `{ site: { name: 'Plant 1' } }` becomes `site.name`, because a Fuuz relation
 * always arrives as a nested object and a column showing `[object Object]` answers
 * nothing. An array or a deeper object stays whole and is JSON-stringified at
 * render time — exploding those would produce a hundred columns from one query.
 */
export function flattenRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isRecord(value) && Object.keys(value).length <= 12 && !Object.values(value).some(isRecord)) {
      for (const [inner, v] of Object.entries(value)) out[`${key}.${inner}`] = v;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The array most likely to be the answer.
 *
 * Longest wins, and ties break toward the shallowest — a paged result sits directly
 * under its query field, while the deep arrays tend to be per-row relations. Wrong
 * often enough to be worth overriding, which is why `alternatives` is returned.
 */
export function preferredArray(arrays: { path: string; count: number }[]): string | undefined {
  if (!arrays.length) return undefined;
  const depth = (p: string) => p.split('.').length;
  return arrays.slice().sort((a, b) => b.count - a.count || depth(a.path) - depth(b.path))[0].path;
}

/**
 * Build a table from a response.
 *
 * `pick` selects the array explicitly; without it the preferred one is used.
 * Returns undefined when there is nothing tabular, so the caller shows the JSON
 * view rather than an empty grid implying an empty result.
 */
export function tabulate(response: unknown, pick?: string): Table | undefined {
  const arrays = findArrays(response);
  const path = pick ?? preferredArray(arrays);
  if (!path) return undefined;
  const raw = at(response, path);
  if (!Array.isArray(raw) || !raw.length) return undefined;

  // A scalar list is a one-column table — honest, and better than refusing.
  if (!raw.some(isRecord)) {
    return { columns: ['value'], rows: raw.map((v) => [v]), path, alternatives: arrays };
  }

  const flat: Record<string, unknown>[] = raw.map((row) => (isRecord(row) ? flattenRecord(row) : { value: row }));
  /*
   * The union of every row's keys, in first-seen order.
   *
   * GraphQL omits nulls, so row 1 having no `notes` while row 2 does is routine.
   * Using row 1's keys would drop the column entirely and the value with it —
   * a silent data loss that looks like a complete table.
   */
  const columns: string[] = [];
  for (const row of flat) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }

  return {
    columns,
    rows: flat.map((row) => columns.map((c) => row[c])),
    path,
    alternatives: arrays,
  };
}

/** One cell, rendered. Objects become compact JSON; null and undefined differ. */
export function cellText(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The table as TSV, which is what pastes into a spreadsheet. */
export function toTsv(table: Table): string {
  const escape = (v: unknown) => cellText(v).replace(/[\t\n\r]/g, ' ');
  return [table.columns.join('\t'), ...table.rows.map((r) => r.map(escape).join('\t'))].join('\n');
}
