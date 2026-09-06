/**
 * Path completion over the screen's live state.
 *
 * The point is not to save typing. It is that **every suggestion carries the
 * value actually sitting at that path**, so you find out what is there before
 * you write the expression that depends on it:
 *
 *   $components.AssetIntakeForm.data.title             "Screen Runner capture"
 *   $components.AssetIntakeForm.data.assetCollection   (not found)
 *   $components.TicketTable.data                       [ 0 items ]
 *
 * That middle line is a real Asset Intake bug, visible before a single
 * character of logic is written. A completer that listed names alone would show
 * all three identically.
 *
 * Completions come from the runtime's own context snapshot, plus any locals the
 * expression binds above the caret (`$me := …`), plus element names from the
 * design so a component can be reached before it has ever produced a value.
 *
 * Pure.
 */
import { formatValue } from './classify';

export interface Completion {
  /** The text to insert, e.g. `$components.AssetIntakeForm.data`. */
  insert: string;
  /** Just the final segment, for display. */
  label: string;
  /** The live value there, already summarised — or why there isn't one. */
  preview: string;
  kind: 'value' | 'object' | 'array' | 'missing' | 'local' | 'element';
}

export interface CompletionRequest {
  /** Character range the completion replaces. */
  from: number;
  to: number;
  items: Completion[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The `$…` token the caret sits inside, if any. */
function tokenAt(text: string, caret: number): { start: number; token: string } | undefined {
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_.$]/.test(text[start - 1])) start -= 1;
  const token = text.slice(start, caret);
  return token.startsWith('$') ? { start, token } : undefined;
}

function describe(value: unknown, found: boolean): { preview: string; kind: Completion['kind'] } {
  if (!found) {
    // Distinguishing "absent" from "null" is the whole diagnostic value here.
    return { preview: '(not found)', kind: 'missing' };
  }
  if (Array.isArray(value)) {
    return { preview: `[ ${value.length} item${value.length === 1 ? '' : 's'} ]`, kind: 'array' };
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return { preview: `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }`, kind: 'object' };
  }
  return { preview: formatValue(value), kind: 'value' };
}

/** Walk a dotted path, reporting whether every segment existed. */
function resolve(root: unknown, segments: string[]): { found: boolean; value?: unknown } {
  let cursor = root;
  for (const segment of segments) {
    if (!isRecord(cursor) || !(segment in cursor)) return { found: false };
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

/**
 * Locals bound above the caret.
 *
 * JSONata's `$name := …` introduces a variable that is in scope for the rest of
 * the expression, and omitting them would make the completer wrong precisely in
 * the expressions long enough to need it.
 */
function localsBefore(text: string, caret: number): string[] {
  const out = new Set<string>();
  for (const m of text.slice(0, caret).matchAll(/\$([A-Za-z_]\w*)\s*:=/g)) out.add(m[1]);
  return [...out];
}

export interface CompletionContext {
  /** The runtime context snapshot — `{ components, metadata, … }`. */
  context: unknown;
  /** Element names from the design, for components with no value yet. */
  elements?: { name: string; type: string }[];
  /**
   * The document under evaluation — JSONata's `$`.
   *
   * Needed because `$.quantity` is the single most common thing to write in a model
   * trigger (`$` is the mutation input) and in a flow node (`$` is the payload), and
   * without it every one of those completions came back "nothing at this path".
   */
  document?: unknown;
}

/**
 * Completions for the caret position, or undefined when not in a `$` token.
 *
 * Ranked so the useful ones come first: exact prefix matches before
 * case-insensitive ones, and present values before missing paths — you are more
 * often reaching for something that exists.
 */
export function completionsAt(
  text: string,
  caret: number,
  { context, elements = [], document }: CompletionContext
): CompletionRequest | undefined {
  const at = tokenAt(text, caret);
  if (!at) return undefined;

  const body = at.token.slice(1);                 // drop the leading `$`
  const parts = body.split('.');
  const partial = parts[parts.length - 1];
  const basePath = parts.slice(0, -1);
  const root = isRecord(context) ? context : {};

  const items: Completion[] = [];
  const prefix = `$${basePath.length ? `${basePath.join('.')}.` : ''}`;

  /*
   * `$.field` — a path into the document rather than a named binding.
   *
   * The token splits to an empty first segment, which used to resolve against the
   * context root, fail, and report "nothing at this path" for every field of the very
   * record being written about. Here the empty segment is what identifies the document.
   */
  if (basePath.length >= 1 && basePath[0] === '') {
    const docRoot = isRecord(document) ? document : {};
    const into = resolve(docRoot, basePath.slice(1));
    if (into.found && isRecord(into.value)) {
      for (const [key, value] of Object.entries(into.value)) {
        items.push({ insert: `${prefix}${key}`, label: key, ...describe(value, true) });
      }
    }
    const lowerDoc = partial.toLowerCase();
    return {
      from: at.start, to: caret,
      items: items
        .filter((i) => i.label.toLowerCase().startsWith(lowerDoc))
        .sort((a, b) => Number(b.label.startsWith(partial)) - Number(a.label.startsWith(partial))
          || a.label.localeCompare(b.label))
        .slice(0, 50),
    };
  }

  if (basePath.length === 0) {
    // Top level: the runtime's own bindings, then locals bound above the caret.
    for (const key of Object.keys(root)) {
      const d = describe(root[key], true);
      items.push({ insert: `$${key}`, label: key, ...d });
    }
    for (const name of localsBefore(text, caret)) {
      items.push({ insert: `$${name}`, label: name, preview: '(local)', kind: 'local' });
    }
  } else {
    const base = resolve(root, basePath);
    if (base.found && isRecord(base.value)) {
      for (const [key, value] of Object.entries(base.value)) {
        const d = describe(value, true);
        items.push({ insert: `${prefix}${key}`, label: key, ...d });
      }
    }

    // A design element with no value yet still belongs in the list — otherwise
    // the only components you can complete are the ones that already ran, which
    // is backwards when you are writing the transform that will populate them.
    if (basePath.length === 1 && basePath[0] === 'components') {
      const known = new Set(items.map((i) => i.label));
      for (const el of elements) {
        if (known.has(el.name)) continue;
        items.push({
          insert: `${prefix}${el.name}`, label: el.name,
          preview: `(${el.type} — no value yet)`, kind: 'element',
        });
      }
    }

    // The base itself did not resolve: say so rather than returning an empty
    // list, which reads as "no suggestions" instead of "that path is not there".
    if (!base.found) {
      return {
        from: at.start, to: caret,
        items: [{
          insert: at.token, label: basePath.join('.'),
          preview: '(not found — nothing at this path)', kind: 'missing',
        }],
      };
    }
  }

  const lower = partial.toLowerCase();
  const matched = items.filter((i) => i.label.toLowerCase().startsWith(lower));
  matched.sort((a, b) => {
    const exact = Number(b.label.startsWith(partial)) - Number(a.label.startsWith(partial));
    if (exact) return exact;
    const present = Number(a.kind === 'missing') - Number(b.kind === 'missing');
    if (present) return present;
    return a.label.localeCompare(b.label);
  });

  return { from: at.start, to: caret, items: matched.slice(0, 50) };
}

/** Apply a completion, returning the new text and where the caret lands. */
export function applyCompletion(
  text: string,
  request: CompletionRequest,
  item: Completion
): { text: string; caret: number } {
  const next = text.slice(0, request.from) + item.insert + text.slice(request.to);
  return { text: next, caret: request.from + item.insert.length };
}
