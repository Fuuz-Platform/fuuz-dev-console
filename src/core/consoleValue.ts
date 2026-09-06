/**
 * Turn a console-rendered value back into something traversable.
 *
 * The flow log prints values the way a console does, not as JSON:
 *
 *     { payload: [] }
 *     { payload: Array(10) }
 *     (8) [{…}, {…}, {…}]
 *     { asset: {…}, count: 3 }
 *
 * `JSON.parse` rejects all of it — unquoted keys, `Array(10)`, `{…}`. So a lenient
 * parser is needed for the fallback path, where no engine event was recorded and
 * this text is all we have.
 *
 * ## What it cannot do, and says so
 *
 * `Array(10)` and `{…}` are the **console's own elisions**. The data was never in
 * the string, so parsing recovers the *shape* and not the contents. Every elision
 * becomes an explicit marker — `{ __elided: 'Array(10)', __count: 10 }` — rather
 * than an empty array that would read as "this was empty" when it means "ten items
 * the console declined to print". Those are opposite conclusions and a developer
 * would act differently on each.
 *
 * Pure.
 */

/** What an elision became, so the UI can render it as absent-not-empty. */
export interface Elided {
  __elided: string;
  __count?: number;
}

export const isElided = (v: unknown): v is Elided =>
  v !== null && typeof v === 'object' && '__elided' in (v as Record<string, unknown>);

interface Cursor { text: string; at: number }

const ws = (c: Cursor) => { while (c.at < c.text.length && /\s/.test(c.text[c.at])) c.at += 1; };

function parseValue(c: Cursor, depth = 0): unknown {
  ws(c);
  if (depth > 12 || c.at >= c.text.length) return undefined;
  const ch = c.text[c.at];

  if (ch === '{') return parseObject(c, depth);
  if (ch === '[') return parseArray(c, depth);
  if (ch === '"' || ch === "'") return parseString(c);

  // `(8) [{…}, {…}]` — the console's array-with-length form.
  const counted = /^\((\d+)\)\s*\[/.exec(c.text.slice(c.at));
  if (counted) {
    c.at += counted[0].length - 1;
    const items = parseArray(c, depth);
    // Keep the stated length: the printed items are usually fewer than the real
    // count, and reporting `items.length` would understate the array.
    return Array.isArray(items) && items.length < Number(counted[1])
      ? { __elided: `Array(${counted[1]})`, __count: Number(counted[1]), sample: items }
      : items;
  }

  // `Array(10)` — a length and nothing else.
  const arr = /^Array\((\d+)\)/.exec(c.text.slice(c.at));
  if (arr) {
    c.at += arr[0].length;
    return { __elided: arr[0], __count: Number(arr[1]) };
  }

  // A bare token: number, boolean, null, or an unquoted word.
  const token = /^[^,}\]\s]+/.exec(c.text.slice(c.at));
  if (!token) { c.at += 1; return undefined; }
  c.at += token[0].length;
  const raw = token[0];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw === 'undefined') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // `…` on its own is an elision marker, not a value.
  if (raw === '…' || raw === '...') return { __elided: '…' };
  return raw;
}

function parseString(c: Cursor): string {
  const quote = c.text[c.at];
  c.at += 1;
  let out = '';
  while (c.at < c.text.length && c.text[c.at] !== quote) {
    if (c.text[c.at] === '\\' && c.at + 1 < c.text.length) { out += c.text[c.at + 1]; c.at += 2; continue; }
    out += c.text[c.at];
    c.at += 1;
  }
  c.at += 1;
  return out;
}

function parseObject(c: Cursor, depth: number): unknown {
  c.at += 1;   // {
  const out: Record<string, unknown> = {};
  let elided = false;
  for (let guard = 0; guard < 500; guard += 1) {
    ws(c);
    if (c.at >= c.text.length) break;
    if (c.text[c.at] === '}') { c.at += 1; break; }
    if (c.text[c.at] === ',') { c.at += 1; continue; }
    // `{…}` — the console printed the object's presence and nothing else.
    if (c.text[c.at] === '…' || c.text.startsWith('...', c.at)) {
      elided = true;
      c.at += c.text[c.at] === '…' ? 1 : 3;
      continue;
    }
    const key = c.text[c.at] === '"' || c.text[c.at] === "'"
      ? parseString(c)
      : (/^[^:,}\s]+/.exec(c.text.slice(c.at))?.[0] ?? '');
    if (!key) { c.at += 1; continue; }
    if (!(c.text[c.at] === '"' || c.text[c.at] === "'")) c.at += key.length;
    ws(c);
    if (c.text[c.at] === ':') c.at += 1;
    out[key] = parseValue(c, depth + 1);
  }
  // An object whose contents were entirely elided must not read as empty.
  if (elided && !Object.keys(out).length) return { __elided: '{…}' };
  if (elided) out.__elided = '{…}';
  return out;
}

function parseArray(c: Cursor, depth: number): unknown[] {
  c.at += 1;   // [
  const out: unknown[] = [];
  for (let guard = 0; guard < 500; guard += 1) {
    ws(c);
    if (c.at >= c.text.length) break;
    if (c.text[c.at] === ']') { c.at += 1; break; }
    if (c.text[c.at] === ',') { c.at += 1; continue; }
    out.push(parseValue(c, depth + 1));
  }
  return out;
}

/**
 * Parse a console-printed value.
 *
 * Returns the string unchanged when it is not a structure — a plain label should
 * not become a one-character object — and never throws: the fallback path exists
 * precisely because the input is unreliable.
 */
export function parseConsoleValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!/^[[{(]/.test(trimmed) && !/^Array\(/.test(trimmed)) return trimmed;
  try {
    const c: Cursor = { text: trimmed, at: 0 };
    const value = parseValue(c);
    return value === undefined ? trimmed : value;
  } catch {
    return trimmed;
  }
}

/** Whether anything in a parsed value was elided, for an honest "partial" label. */
export function hasElision(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (isElided(value)) return true;
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return values.some((v) => hasElision(v, depth + 1));
}
