/**
 * Turning a state-tree node into something you can paste.
 *
 * Two different needs: the **path** to reference the value in a transform
 * (`$metadata.urlParameters.screenVersionId`), and the **value** itself for a
 * bug report or a test fixture. They're different clipboard payloads, so they
 * get different buttons.
 *
 * Pure.
 */

/** Roots the runtime binds as JSONata variables. */
const BOUND_ROOTS = new Set(['metadata', 'components', 'variables', 'state', 'props', 'context']);

/**
 * The tree path as a transform would reference it.
 *
 * `metadata.urlParameters.screenVersionId` → `$metadata.urlParameters.screenVersionId`.
 * The synthetic `Screen` root and our `(computed)` bucket aren't referenceable,
 * so they're stripped or reported as unavailable.
 */
export function toTransformPath(nodeId: string): string | undefined {
  if (!nodeId || nodeId === '__screen__') return undefined;
  const path = nodeId.replace(/^__screen__\./, '');
  const root = path.split('.')[0];
  if (root === '(computed)' || root === '(local)') return undefined;
  if (!BOUND_ROOTS.has(root)) return undefined;
  return `$${path}`;
}

/**
 * The value as JSON, keyed by its own leaf name — which is what you want in a
 * bug report or a fixture, rather than a bare scalar with no context.
 */
export function toValueJson(nodeId: string, value: unknown): string {
  const leaf = nodeId.split('.').pop() ?? 'value';
  return JSON.stringify({ [leaf]: value }, null, 2);
}

/**
 * The tree stores values pre-formatted for display, so recover the real one
 * where we can — a quoted string, a number, a boolean, null. Anything
 * summarised (`[ 12 items ]`) can't be recovered and is returned as-is.
 */
export function parseDisplayValue(display: string | undefined): unknown {
  if (display === undefined) return undefined;
  if (display === 'null') return null;
  if (display === 'true') return true;
  if (display === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(display)) return Number(display);
  if (/^".*"$/.test(display)) {
    try { return JSON.parse(display); } catch { return display.slice(1, -1); }
  }
  return display;
}

/**
 * How a transform references one element's property.
 *
 * `$components.AssetIntakeForm.disabled`. This is the path the designer's own
 * expression editor expects, and copying it by hand from a tree row means
 * retyping the element name — the most common source of a silently-null read.
 *
 * Returns undefined for an unnamed element, because `$components..disabled` is
 * worse than no button.
 */
export function toComponentPath(elementName: string | undefined, property?: string): string | undefined {
  if (!elementName || /[^A-Za-z0-9_$]/.test(elementName)) return undefined;
  return property ? `$components.${elementName}.${property}` : `$components.${elementName}`;
}

