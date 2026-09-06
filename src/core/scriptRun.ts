/**
 * Running a script against a payload and a context, the way a Fuuz flow does.
 *
 * The scratchpad evaluates JSONata against a *captured* screen context. This is the
 * other half: an arbitrary payload and context you type yourself, so a transform can
 * be worked out before a screen or a flow exists to run it in — and in JavaScript as
 * well as JSONata, because a lot of flow logic is easier to prototype imperatively
 * and then port.
 *
 * ## The binding convention, which is not arbitrary
 *
 * A Fuuz flow node receives the payload as `$` — the document under evaluation — and
 * everything else as named bindings: `$state`, `$metadata`, `$appConfig`. So:
 *
 *   JSONata     the payload is the input document; every context key is bound as
 *               `$name`, so `$state.orderId` resolves exactly as it would in a node
 *   JavaScript  `payload` and `context` are arguments, and every context key is
 *               also a top-level const, so `state.orderId` works
 *
 * Getting this wrong would make the scratchpad useless in the way that matters: an
 * expression that works here has to work when pasted into the designer.
 *
 * Pure — the JavaScript evaluation itself happens in a sandboxed frame, because an
 * extension page's CSP forbids `eval`. This module only prepares and interprets.
 */

export type ScriptLanguage = 'javascript' | 'jsonata';

export interface ParsedInputs {
  payload: unknown;
  context: Record<string, unknown>;
  /** Which input failed to parse, with the parser's own message. */
  error?: string;
}

/**
 * Parse the two JSON inputs.
 *
 * Empty is `{}` rather than an error — starting with a blank payload is the normal
 * case, and refusing to run until something is typed in both boxes would be
 * obstructive. A *malformed* input is an error, and it names which box, because
 * "Unexpected token }" without that is a guessing game.
 */
export function parseInputs(payloadText: string, contextText: string): ParsedInputs {
  let payload: unknown = {};
  let context: Record<string, unknown> = {};
  if (payloadText.trim()) {
    try { payload = JSON.parse(payloadText); }
    catch (e) { return { payload: {}, context: {}, error: `Payload is not valid JSON — ${message(e)}` }; }
  }
  if (contextText.trim()) {
    try {
      const parsed = JSON.parse(contextText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { payload, context: {}, error: 'Context must be a JSON object — its keys become $state, $metadata and so on.' };
      }
      context = parsed as Record<string, unknown>;
    } catch (e) { return { payload, context: {}, error: `Context is not valid JSON — ${message(e)}` }; }
  }
  return { payload, context };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The source actually evaluated in the sandbox.
 *
 * Wrapped in an async function so `await` works — half of what you would prototype
 * involves a promise — and with the context spread into consts so `state.x` reads
 * the same as `$state.x` does in JSONata.
 *
 * A script with no `return` gets its last expression returned instead, because
 * typing `payload.items.length` and seeing `undefined` is a papercut that makes the
 * tool feel broken. That only applies to a single-expression script: anything with
 * statements is left alone, since guessing where to insert a `return` in real code
 * would be wrong more often than right.
 */
export function wrapScript(source: string, contextKeys: string[]): string {
  const consts = contextKeys
    .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
    .map((k) => `const ${k} = context[${JSON.stringify(k)}];`)
    .join('\n');
  const body = looksLikeExpression(source) ? `return (${source.trim()});` : source;
  return `return (async (payload, context) => {\n${consts}\n${body}\n})(__payload, __context);`;
}

/**
 * Whether the script is one expression rather than a program.
 *
 * Deliberately conservative: no `return`, no statement keywords, no semicolon or
 * newline separating statements. `payload.items[0].name` qualifies; anything with
 * control flow does not.
 */
export function looksLikeExpression(source: string): boolean {
  const s = source.trim();
  if (!s) return false;
  if (/\breturn\b/.test(s)) return false;
  if (/^(const|let|var|if|for|while|function|class|try|switch|throw)\b/.test(s)) return false;
  // A trailing semicolon is fine; an internal one means statements.
  return !/[;\n]/.test(s.replace(/;\s*$/, ''));
}

export interface ScriptResult {
  ok: boolean;
  /** The returned value, already JSON-safe. */
  value?: unknown;
  error?: string;
  /** Anything the script logged, in order. */
  logs?: string[];
  elapsedMs?: number;
}

/**
 * Make a value safe to postMessage and to stringify.
 *
 * A script can return a function, a circular object, a BigInt or an Error — none of
 * which survive `structuredClone` or `JSON.stringify`. Each becomes a readable
 * marker instead of taking down the whole run, because losing the answer to a
 * serialisation failure is the worst outcome available.
 */
export function toTransferable(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 12) return '[too deep]';
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'bigint') return `${String(value)}n`;
  if (t === 'function') return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
  if (t === 'symbol') return String(value);
  if (t !== 'object') return value;

  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof Date) return value.toISOString();

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  if (Array.isArray(value)) return value.map((v) => toTransferable(v, seen, depth + 1));
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), toTransferable(v, seen, depth + 1)]));
  if (value instanceof Set) return [...value].map((v) => toTransferable(v, seen, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = toTransferable(v, seen, depth + 1);
  return out;
}
