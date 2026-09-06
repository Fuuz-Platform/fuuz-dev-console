/**
 * Read the Fuuz console's values out of its **DOM**, not its text.
 *
 * This corrects a wrong assumption. Scraping `textContent` produced `{…}` and
 * `Array(10)` and I concluded the console had elided the data — so the fallback
 * path was written to treat those as unrecoverable. It had not: the console
 * renders every key and value as its own coloured span, and the real values are
 * in the page. `textContent` merely flattens them away.
 *
 *     <span>
 *       <span style="color: rgb(227, 110, 236)">tenantId</span>
 *       <span>: </span>
 *       <span style="color: rgb(233, 63, 59)">"exampleTenantBuild"</span>
 *     </span>
 *
 * So the value type comes from the **colour** the console painted it, and the
 * structure comes from DOM nesting. No parsing of rendered text, no elisions to
 * work around.
 *
 * Pure — takes an element, touches nothing.
 */

/**
 * Colours the console paints each token, as RGB triples.
 *
 * Matched loosely: a theme change would shift the exact values, so a token whose
 * colour is unrecognised falls back to inferring from its text rather than being
 * dropped. Losing a value because a hue moved would be worse than a wrong guess
 * about its type.
 */
const KEY_RGB = [227, 110, 236];
const STRING_RGB = [233, 63, 59];

function rgbOf(style: string | null): [number, number, number] | undefined {
  const m = /rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(style ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const near = (a: [number, number, number] | undefined, b: number[]) =>
  !!a && Math.abs(a[0] - b[0]) < 40 && Math.abs(a[1] - b[1]) < 40 && Math.abs(a[2] - b[2]) < 40;

/** Turn a token's text into a typed value, using its colour as the hint. */
function typedValue(text: string, isStringColoured: boolean): unknown {
  const raw = text.trim();
  if (isStringColoured || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.replace(/^"|"$/g, '');
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw === 'undefined') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** A key span, by colour or by being followed by a `:` separator. */
function isKey(el: Element): boolean {
  if (near(rgbOf(el.getAttribute('style')), KEY_RGB)) return true;
  const next = el.nextElementSibling;
  return !!next && /^\s*:\s*$/.test(next.textContent ?? '');
}

/**
 * Read one console row into a value.
 *
 * Walks the element tree collecting `key: value` pairs, using nesting to build
 * objects. An element with keyed children becomes an object; one with none becomes
 * its own typed scalar.
 */
export function readConsoleValue(el: Element, depth = 0): unknown {
  if (depth > 14) return '[too deep]';

  const children = Array.from(el.children);
  if (!children.length) {
    return typedValue(el.textContent ?? '', near(rgbOf(el.getAttribute('style')), STRING_RGB));
  }

  const out: Record<string, unknown> = {};
  let found = 0;

  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!isKey(child)) continue;
    const key = (child.textContent ?? '').trim().replace(/^"|"$/g, '').replace(/:$/, '');
    if (!key) continue;

    // The value is the next sibling that is not the `:` separator.
    let valueEl: Element | undefined;
    for (let j = i + 1; j < children.length; j += 1) {
      const candidate = children[j];
      if (/^\s*:\s*$/.test(candidate.textContent ?? '')) continue;
      valueEl = candidate;
      break;
    }
    if (!valueEl) continue;
    out[key] = readConsoleValue(valueEl, depth + 1);
    found += 1;
  }

  // No keys at this level: the pairs are one deeper, each in its own wrapper span.
  if (!found) {
    const nested = children
      .map((c) => readConsoleValue(c, depth + 1))
      .filter((v) => v !== '' && v !== undefined);
    if (!nested.length) return typedValue(el.textContent ?? '', near(rgbOf(el.getAttribute('style')), STRING_RGB));

    /*
     * Merge sibling single-key objects into one.
     *
     * The console wraps every `key: value` pair in its own span, so a four-field
     * object arrives as four sibling wrappers. Returning them as an array would
     * make `metadata.flowId` unreachable — it would be `metadata[0].flowId` — so
     * objects are merged and anything else stays a list.
     */
    const allObjects = nested.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
    if (allObjects && nested.length > 1) {
      return Object.assign({}, ...(nested as Record<string, unknown>[]));
    }
    return nested.length === 1 ? nested[0] : nested;
  }
  return out;
}

/**
 * Every expanded row inside a console log region, as real values.
 *
 * Only what the console has actually rendered: a collapsed node genuinely is not
 * in the DOM, so `expandedOnly` is reported rather than implied. That is a real
 * limit — but a different one from "the values are elided", which was wrong.
 */
export interface ConsoleDomRead {
  values: unknown[];
  /** Rows read. */
  count: number;
  /**
   * True when the region contains collapsed markers, so some subtrees are not
   * present until the developer expands them in Fuuz's own console.
   */
  hasCollapsed: boolean;
}

/**
 * Whether a read produced something real, or only the console's own furniture.
 *
 * A **collapsed** row has no content in the DOM — `▶input:` is a glyph and a
 * label, and the value appears only once the developer expands it in Fuuz. Reading
 * such a row structurally yields the expander triangles as array items and empty
 * strings as values, which is worse than not reading it: it looks like data.
 *
 * So a result is rejected when it carries expander glyphs or is all-empty, and the
 * caller falls back to the row's text instead of rendering nonsense.
 */
export function isUsableRead(value: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  if (typeof value === 'string') {
    // `▶` is the expander itself; `(8)` is a length with its contents unexpanded.
    return value !== '' && !/^[▶▸▾]$/.test(value.trim()) && !/^\(\d+\)$/.test(value.trim());
  }
  if (value === null || typeof value !== 'object') return value !== undefined;
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  if (!values.length) return false;
  // Real content anywhere is enough; furniture alone is not.
  return values.some((v) => isUsableRead(v, depth + 1));
}

/**
 * Read a row only if it is expanded enough to be worth reading.
 *
 * Returns undefined for a collapsed row so the caller can use its text, rather
 * than presenting the console's furniture as though it were the payload.
 */
export function readExpandedRow(el: Element): unknown {
  const value = readConsoleValue(el);
  if (!isUsableRead(value)) return undefined;
  // A row whose only content is the expander labels is still not data.
  const text = JSON.stringify(value) ?? '';
  if (/"[▶▸▾]"/.test(text) && !/[a-z]{3,}":\s*"[^"]{2,}/i.test(text)) return undefined;
  return value;
}

export function readConsoleRegion(region: Element): ConsoleDomRead {
  const rows = Array.from(region.children);
  const values = rows.map((row) => readConsoleValue(row)).filter((v) => v !== undefined && v !== '');
  // The console marks an unexpanded subtree with its own glyph; its presence means
  // the DOM is short of the full object, which is worth reporting honestly.
  // No `\b` before `Array`: in "1Array(10)" there is no word boundary, so the
  // check silently never matched.
  const hasCollapsed = /…|Array\(\d+\)|\{…\}/.test(region.textContent ?? '');
  return { values, count: rows.length, hasCollapsed };
}
