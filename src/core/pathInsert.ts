/**
 * Turning a click on a value into the path that reads it.
 *
 * The payload and context boxes hold the data a script runs against, and the most common
 * thing anyone does with them is read a value out — which meant reading the JSON, working
 * out the path by eye, and typing it. Every typo there produces a silent null, which is the
 * single most common way a Fuuz expression goes wrong.
 *
 * So a click builds the path instead. The two boxes root differently, and the difference is
 * not cosmetic:
 *
 *   payload   JSONata's **document**, so its paths start `$.` — `$.quantity`
 *   context   **named bindings**, so a top-level key *is* the name — `$state`, not
 *             `$.state`, and nested from there — `$state.orderId`
 *
 * Getting that backwards would produce paths that look right and resolve to nothing, which
 * is exactly the failure this exists to prevent.
 *
 * Pure.
 */

export type PathRoot = 'document' | 'bindings';

/**
 * The JSONata path for a value at `segments`.
 *
 * Array indices become `[0]` rather than `.0`, because JSONata reads `a.0` as a field
 * literally named `0`. Keys that are not bare identifiers are bracket-quoted for the same
 * reason: `$.["order id"]` resolves, `$.order id` is a syntax error.
 */
export function pathFor(root: PathRoot, segments: (string | number)[]): string {
  if (!segments.length) return root === 'document' ? '$' : '$';

  const parts: string[] = [];
  let head = '$';

  segments.forEach((segment, i) => {
    if (typeof segment === 'number') {
      parts.push(`[${segment}]`);
      return;
    }
    /*
     * The first segment of a binding path *is* the binding name.
     *
     * `$state`, not `$.state`. Everything after it is ordinary field access, and the
     * document root has no such special case — its first segment is already a field.
     */
    if (i === 0 && root === 'bindings') {
      head = identifier(segment) ? `$${segment}` : `$[${quote(segment)}]`;
      return;
    }
    parts.push(identifier(segment) ? `.${segment}` : `[${quote(segment)}]`);
  });

  // A document path needs the leading dot that separates `$` from its first field; a
  // binding path already carries its name in `head`.
  if (root === 'document' && parts.length && parts[0].startsWith('.')) return `${head}${parts.join('')}`;
  if (root === 'document' && parts.length) return `${head}${parts.join('')}`;
  return `${head}${parts.join('')}`;
}

const identifier = (key: string) => /^[A-Za-z_$][\w$]*$/.test(key);
const quote = (key: string) => `"${key.replace(/(["\\])/g, '\\$1')}"`;

/**
 * Splice text into a script at the caret.
 *
 * Returns the new text and where the caret should land — **after** the insertion, so typing
 * continues naturally. A selection is replaced, which is what every editor does and what
 * makes "select the wrong path, click the right one" work.
 *
 * A space is added when the insertion would otherwise weld onto an adjacent word, because
 * `$state.a$state.b` is not what anyone meant by two clicks. Punctuation and whitespace are
 * left alone — `(` then a path is correct as it stands.
 */
export function insertAt(
  text: string,
  start: number,
  end: number,
  insert: string
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(start, text.length));
  const to = Math.max(at, Math.min(end, text.length));
  const before = text.slice(0, at);
  const after = text.slice(to);

  const needsSpaceBefore = /[\w$\])]$/.test(before);
  const needsSpaceAfter = /^[\w$([]/.test(after);
  const body = `${needsSpaceBefore ? ' ' : ''}${insert}${needsSpaceAfter ? ' ' : ''}`;

  return {
    text: `${before}${body}${after}`,
    // Before a trailing space, not after it: the caret sits at the end of what was
    // inserted, so the next click or keystroke continues from the path itself.
    caret: at + body.length - (needsSpaceAfter ? 1 : 0),
  };
}

/** A short preview of a value, for the row you are about to click. */
export function previewOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[ ${value.length} item${value.length === 1 ? '' : 's'} ]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }`;
  }
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  return String(value);
}


/* ── Searching the payload and context ────────────────────────────────────── */

export interface PathMatch {
  /** The JSONata path that reads this value. */
  path: string;
  /** The key that matched, for display. */
  label: string;
  /** A one-line rendering of the value. */
  preview: string;
  /** Which side of the match won — a key, or the value itself. */
  on: 'key' | 'value';
  /** How deep, so shallow matches can be offered first. */
  depth: number;
}

/**
 * Every path in a payload or context whose key or value matches.
 *
 * Browsing a tree is fine when you know roughly where something is. When you do not — and a
 * captured screen context is thousands of nodes across dozens of elements — expanding your way
 * to `libraryId` is the wrong tool entirely. Searching matches **values as well as keys**,
 * because "which element holds `LIB-002`" is at least as common a question as "where is
 * `libraryId`", and only one of them can be answered by a key search.
 *
 * Shallow matches rank first, then key matches over value matches: a top-level key called
 * `title` is much more likely to be what you meant than the twelfth row's `title` field.
 *
 * Bounded on both depth and results — a search that walks a whole capture unbounded would
 * block the panel on every keystroke.
 */
export function searchPaths(
  value: unknown,
  root: PathRoot,
  query: string,
  limit = 60
): PathMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const out: PathMatch[] = [];
  const walk = (node: unknown, segments: (string | number)[], depth: number) => {
    if (out.length >= limit * 4 || depth > 10) return;

    if (node !== null && typeof node === 'object') {
      const entries: [string | number, unknown][] = Array.isArray(node)
        ? node.slice(0, 60).map((v, i) => [i, v])
        : Object.entries(node as Record<string, unknown>);
      for (const [key, child] of entries) {
        const path = [...segments, key];
        // A key match is recorded and the subtree is still walked: `data` matching does not
        // mean nothing inside `data` can match too.
        if (typeof key === 'string' && key.toLowerCase().includes(needle)) {
          out.push({ path: pathFor(root, path), label: String(key), preview: previewOf(child), on: 'key', depth });
        }
        walk(child, path, depth + 1);
      }
      return;
    }

    // A leaf whose own value matches — "which element holds LIB-002".
    if (node !== undefined && node !== null && String(node).toLowerCase().includes(needle)) {
      out.push({
        path: pathFor(root, segments),
        label: String(segments[segments.length - 1] ?? '$'),
        preview: previewOf(node),
        on: 'value',
        depth,
      });
    }
  };
  walk(value, [], 0);

  const seen = new Set<string>();
  return out
    .sort((a, b) => a.depth - b.depth
      || (a.on === b.on ? 0 : a.on === 'key' ? -1 : 1)
      || a.path.localeCompare(b.path))
    .filter((m) => {
      // The same path can match on both its key and its value; one row is enough.
      if (seen.has(m.path)) return false;
      seen.add(m.path);
      return true;
    })
    .slice(0, limit);
}
