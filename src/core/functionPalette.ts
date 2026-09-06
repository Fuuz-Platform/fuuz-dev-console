/**
 * The functions and operators that apply to whatever the cursor is on.
 *
 * A flat list of 64 JSONata functions is a reference, not a tool: knowing that `$sum` exists
 * does not help while you are looking at a string, and finding it means reading past sixty
 * others. So the palette is filtered by the **type of the value at the cursor**, which the
 * panel already knows — the payload and context are right there, parsed.
 *
 * `$.payload.LiveStreamCount` resolves to a number, so the palette offers `$sum`, `$abs`,
 * `$round`, `+`, `-`, `*`. Clicking `$sum` rewrites the expression to
 * `$sum($.payload.LiveStreamCount)` with the caret inside the parentheses at the end of the
 * argument, ready for the next thing. That is the difference between a catalogue and a
 * keyboard.
 *
 * The catalogue is generated from the platform's own `fuuz-expressions` skill
 * (`scripts/extract-functions.mjs`), so it cannot drift from what the runtime actually
 * provides — and there is no hand-typed list to go stale.
 *
 * Pure.
 */
import RAW from './data/jsonataFunctions.json';

export type ValueType = 'number' | 'string' | 'boolean' | 'array' | 'object' | 'date' | 'null' | 'unknown';

export interface FunctionDoc {
  name: string;
  signature: string;
  /** How many arguments the signature declares, so a wrap can place the caret. */
  arity: number;
  /** The type this function is *for* — what its first argument holds. */
  applies: string;
  section: string;
  description: string;
  /**
   * Where it can actually run.
   *
   * `jsonata` — the standard library, which this panel's bundled engine evaluates.
   * `fuuz` — the platform's own library (`$query`, `$cuid`, `$moment`, `$semverGt` …), which exists
   * only inside Fuuz. Offering these is right: they are most of what a real transform uses. But the
   * local runner *cannot* execute them, and letting someone press Run and read "unknown function"
   * without explanation would be the tool lying by omission.
   */
  origin: 'jsonata' | 'fuuz';
  /**
   * True when a model trigger may not call it.
   *
   * Triggers run read-only, so `$mutate` and friends are rejected by the platform at save time.
   * Offering them in trigger mode would hand over an expression that cannot be used.
   */
  notInTriggers?: boolean;
}

export const FUNCTIONS = RAW as FunctionDoc[];

/**
 * The type of a value, as the palette groups them.
 *
 * An ISO-8601 string is reported as a **date**, because `$toMillis` and `$fromMillis` are what
 * you actually want on one — while every string function still applies, so dates are offered
 * alongside strings rather than instead of them.
 */
export function typeOf(value: unknown): ValueType {
  if (value === null) return 'null';
  if (value === undefined) return 'unknown';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/.test(value) ? 'date' : 'string';
  }
  return 'unknown';
}

/**
 * Operators worth offering per type.
 *
 * Included because they are what you reach for *next*: having wrapped a count in `$sum`, the
 * following keystroke is usually `+` or `>`. Sending someone back to the keyboard for that
 * breaks the flow the palette exists to create.
 *
 * JSONata has no `!` — `$not()` is the only negation — and `&` is string concatenation, not
 * `+`. Both are mistakes people bring from JavaScript, so the palette offers the correct one
 * and never the familiar wrong one.
 */
const OPERATORS: Record<string, { op: string; hint: string }[]> = {
  number: [
    { op: '+', hint: 'add' }, { op: '-', hint: 'subtract' },
    { op: '*', hint: 'multiply' }, { op: '/', hint: 'divide' }, { op: '%', hint: 'remainder' },
    { op: '>', hint: 'greater than' }, { op: '<', hint: 'less than' },
    { op: '=', hint: 'equals' }, { op: '!=', hint: 'not equals' },
  ],
  string: [
    { op: '&', hint: 'concatenate — JSONata has no + for strings' },
    { op: '=', hint: 'equals' }, { op: '!=', hint: 'not equals' },
    { op: 'in', hint: 'is a member of' },
  ],
  boolean: [
    { op: 'and', hint: 'both' }, { op: 'or', hint: 'either' },
    { op: '=', hint: 'equals' },
  ],
  array: [
    { op: '[', hint: 'filter or index' }, { op: 'in', hint: 'membership' },
    { op: '~>', hint: 'chain into a function' },
  ],
  object: [{ op: '.', hint: 'field access' }, { op: '~>', hint: 'chain into a function' }],
  date: [{ op: '<', hint: 'before' }, { op: '>', hint: 'after' }],
  null: [{ op: '=', hint: 'equals' }],
  unknown: [],
};

export interface Palette {
  /** What the cursor is on, as far as we could tell. */
  type: ValueType;
  /** The expression the palette would wrap, when there is one. */
  subject?: string;
  functions: FunctionDoc[];
  operators: { op: string; hint: string }[];
}

/**
 * The palette for a value of this type.
 *
 * Type-specific functions first, then the casts and tests that apply to anything. A `date` gets
 * the string functions too, since it *is* a string — offering only four date functions on an
 * ISO timestamp would hide `$substringBefore`, which is how anyone actually takes the date part
 * off one.
 */
export function paletteFor(type: ValueType, subject?: string, context?: 'trigger'): Palette {
  const wanted = new Set<string>([type]);
  if (type === 'date') wanted.add('string');
  // An array of numbers is the normal subject of `$sum` — offer numeric functions too, since
  // JSONata's aggregations map over paths.
  if (type === 'array') wanted.add('number');

  /*
   * A trigger cannot call the write functions, so they are not offered there.
   *
   * Filtered rather than dimmed: unlike a type mismatch, which JSONata may coerce past, this one is
   * refused by the platform outright — so there is no case where clicking it was what you wanted.
   */
  const allowed = context === 'trigger' ? FUNCTIONS.filter((f) => !f.notInTriggers) : FUNCTIONS;

  const specific = allowed.filter((f) => wanted.has(f.applies));
  const universal = allowed.filter((f) => f.applies === 'any');

  return {
    type,
    subject,
    functions: type === 'unknown' ? allowed : [...specific, ...universal],
    operators: OPERATORS[type] ?? [],
  };
}

/**
 * Whether an expression uses functions the local runner cannot evaluate.
 *
 * Checked before running rather than after failing, so the message can name them and say where they
 * *do* work — "unknown function: $query" tells you nothing about the fact that the expression is
 * correct and simply cannot be tested here.
 */
export function platformFunctionsIn(expression: string): string[] {
  const used = new Set<string>();
  for (const match of expression.matchAll(/\$[A-Za-z_][\w]*/g)) {
    const fn = FUNCTIONS.find((f) => f.name === match[0]);
    if (fn?.origin === 'fuuz') used.add(fn.name);
  }
  return [...used].sort();
}

/**
 * Search the whole catalogue, regardless of type.
 *
 * The palette is a filter, not a cage: sometimes you know the function you want and the cursor
 * happens to be somewhere unhelpful. Matching the description as well as the name means
 * "concatenate" finds `$join` and `&`, which the name alone would not.
 */
export function findFunctions(query: string): FunctionDoc[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return FUNCTIONS.filter((f) =>
    f.name.toLowerCase().includes(q)
    || f.description.toLowerCase().includes(q)
    || f.section.toLowerCase().includes(q));
}

/* ── Rewriting the expression ─────────────────────────────────────────────── */

/**
 * The expression the caret is sitting on or just after.
 *
 * A JSONata path can hold `$`, letters, digits, dots and bracketed indices, so the token is
 * scanned outward across exactly those. Whitespace, operators and parentheses end it — which is
 * what makes `$sum(x) + y` with the caret at the end pick up `y` rather than the whole line.
 */
export function tokenAround(text: string, caret: number): { start: number; end: number; text: string } {
  const at = Math.max(0, Math.min(caret, text.length));
  const isPart = (ch: string) => /[\w$.\][]/.test(ch);

  let start = at;
  while (start > 0 && isPart(text[start - 1])) start -= 1;
  let end = at;
  while (end < text.length && isPart(text[end])) end += 1;

  return { start, end, text: text.slice(start, end) };
}

/**
 * Wrap an expression in a function call.
 *
 * `$.payload.LiveStreamCount` + `$sum` becomes `$sum($.payload.LiveStreamCount)` with the caret
 * **inside the parentheses, after the argument** — because the next thing you type is another
 * argument or an operator, and putting the caret after the closing paren would mean navigating
 * back in for either.
 *
 * With nothing to wrap, the call is inserted empty and the caret goes between the parentheses,
 * which is the same rule applied to an empty subject.
 *
 * A function taking more than one argument gets a comma, since a bare `$round(x)` is valid but
 * `$power(x)` is not — the comma is a prompt for the argument the signature requires.
 */
export function wrapInFunction(
  text: string,
  token: { start: number; end: number },
  fn: FunctionDoc
): { text: string; caret: number } {
  const subject = text.slice(token.start, token.end);
  /*
   * Only the *first* parameter is filled by the subject.
   *
   * `$substring(str, start, length?)` wrapped around a string should become
   * `$substring(str, )` — the required second argument prompted for, the optional third not.
   * Counting optionals is what the arity in the catalogue is for.
   */
  const needsMore = fn.arity > 1 && !/\?\)$/.test(fn.signature);
  const body = needsMore ? `${subject}, ` : subject;
  const call = `${fn.name}(${body})`;

  return {
    text: text.slice(0, token.start) + call + text.slice(token.end),
    // Inside the parentheses, at the end of what is there.
    caret: token.start + fn.name.length + 1 + body.length,
  };
}

/** Append an operator at the caret, spaced as JSONata is normally written. */
export function appendOperator(text: string, caret: number, op: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  // `[` and `.` bind tightly to what precedes them; the arithmetic and word operators do not.
  const tight = op === '[' || op === '.';
  const body = tight ? op : `${/\s$/.test(before) ? '' : ' '}${op} `;
  return { text: `${before}${body}${after}`, caret: at + body.length };
}


/* ── What the cursor is actually on ───────────────────────────────────────── */

/**
 * Resolve a JSONata path against the payload and context, to learn its type.
 *
 * Deliberately a *path walk*, not an evaluation: evaluating arbitrary text on every keystroke
 * would be slow and would throw constantly on half-typed input. A path is the case that matters
 * — you have just clicked `$.payload.LiveStreamCount` in and want to know it is a number — and
 * anything more complex reports `unknown`, which offers the whole catalogue rather than a wrong
 * subset.
 */
export function resolveType(
  expression: string,
  payload: unknown,
  context: Record<string, unknown>
): ValueType {
  const path = expression.trim();
  if (!path.startsWith('$')) {
    // A literal is still typeable, and typing one is a normal way to start.
    if (/^-?\d+(\.\d+)?$/.test(path)) return 'number';
    if (/^(true|false)$/.test(path)) return 'boolean';
    if (/^["'].*["']$/.test(path)) return 'string';
    return 'unknown';
  }

  // `$.a.b` walks the document; `$state.a` walks the binding of that name.
  const body = path.slice(1);
  let cursor: unknown;
  let rest: string[];

  if (body.startsWith('.')) {
    cursor = payload;
    rest = body.slice(1).split('.').filter(Boolean);
  } else {
    const segments = body.split('.').filter(Boolean);
    if (!segments.length) return typeOf(payload);
    const [head, ...tail] = segments;
    // An index on the binding itself: `$rows[0]`.
    const bare = head.replace(/\[\d+\]$/, '');
    cursor = context[bare];
    if (bare !== head) cursor = indexInto(cursor, head);
    rest = tail;
  }

  for (const raw of rest) {
    const key = raw.replace(/\[\d+\]$/, '');
    if (cursor === null || typeof cursor !== 'object') return 'unknown';
    cursor = (cursor as Record<string, unknown>)[key];
    if (key !== raw) cursor = indexInto(cursor, raw);
  }
  return typeOf(cursor);
}

/** Apply a trailing `[n]` to a value. */
function indexInto(value: unknown, segment: string): unknown {
  const m = /\[(\d+)\]$/.exec(segment);
  if (!m || !Array.isArray(value)) return value;
  return value[Number(m[1])];
}


/* ── The inverse: which data suits the function you picked ────────────────── */

/**
 * Whether a value of this type is a sensible first argument to a function of that kind.
 *
 * The inverse of the palette. Having chosen `$substring`, the numbers in the payload are not what
 * you are looking for — dimming them narrows a large capture to the parts that fit, which is the
 * same filtering the palette does, applied the other way round.
 *
 * Deliberately **advisory**. JSONata coerces: `$string(42)` is correct and `$sum` over a path of
 * numeric strings works. So this greys out rather than disables — a wrong hint costs a moment's
 * hesitation, where a lock would make a legitimate expression impossible to write.
 */
export function accepts(applies: string, type: ValueType): boolean {
  if (applies === 'any' || type === 'unknown') return true;
  if (applies === type) return true;
  // An aggregation over a path of numbers is the normal shape, so a number suits an array function.
  if (applies === 'array' && type === 'number') return true;
  // A date *is* a string, so every string function applies to one.
  if (applies === 'string' && type === 'date') return true;
  // `$toMillis` takes the ISO string a date is.
  if (applies === 'date' && type === 'string') return true;
  return false;
}

/**
 * Whether anything inside a value would suit the function.
 *
 * The part that makes dimming usable rather than obstructive: `$components` is an object, and
 * `$substring` does not apply to an object — but the string you want is three levels inside it. A
 * greyed-out branch you cannot see into would hide the very value the filter is meant to find.
 *
 * Depth-bounded, because this runs per row on every keystroke.
 */
export function subtreeAccepts(value: unknown, applies: string, depth = 0): boolean {
  if (depth > 6) return false;
  if (accepts(applies, typeOf(value))) return true;
  if (value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value.slice(0, 40) : Object.values(value as Record<string, unknown>);
  return children.some((child) => subtreeAccepts(child, applies, depth + 1));
}
