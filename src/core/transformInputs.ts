/**
 * The exact inputs to one transform.
 *
 * The provenance chain answers "everything that led here", which is the right
 * answer for a deep investigation and the wrong one when you just want to know
 * why `hidden` is true. This answers the narrow question: here is the
 * expression, here are the paths it reads, and here is the value each one
 * actually held when it ran — taken from the context snapshot logged alongside
 * that very evaluation, so the values are the ones it saw, not today's.
 *
 * Pure.
 */
import { formatValue } from './classify';
import type { LogEntry } from './types';

export interface TransformInput {
  /** Normalized read path, e.g. `components.AssetIntakeForm.data.title`. */
  path: string;
  /** The value at evaluation time, formatted. */
  value: string;
  /** False when the path resolved to nothing — usually the bug. */
  resolved: boolean;
  /** A local binding (`$doc`) rather than screen state. */
  local: boolean;
}

export interface TransformDetail {
  entryId: string;
  /** What it produced. */
  property?: string;
  writes: string;
  result?: string;
  expression?: string;
  durationMs?: number;
  elementName?: string;
  elementType?: string;
  cacheKey?: string;
  remote?: boolean;
  inputs: TransformInput[];
}

/** Walk a dot path through the logged context. */
function readPath(context: unknown, path: string): { value: unknown; found: boolean } {
  let cur: unknown = context;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) return { value: undefined, found: false };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { value: cur, found: true };
}

/**
 * Resolve one entry into its expression and the values behind it.
 *
 * `entry.context` is the snapshot the runtime logged with this evaluation, so
 * reads resolve against exactly the state the transform saw.
 */
export function transformInputs(entry: LogEntry): TransformDetail {
  const inputs: TransformInput[] = entry.reads.map((path) => {
    const local = path.startsWith('(local)');
    if (local) return { path, value: '(transform-local binding)', resolved: true, local: true };
    const { value, found } = readPath(entry.context, path);
    return { path, value: found ? formatValue(value, 140) : '(not found)', resolved: found, local: false };
  });

  return {
    entryId: entry.id,
    property: entry.write ? entry.write.split('.').pop() : undefined,
    writes: entry.write,
    result: entry.after,
    expression: entry.expr,
    durationMs: entry.durMs,
    elementName: entry.write.startsWith('components.') ? entry.write.split('.')[1] : undefined,
    elementType: entry.elementType,
    cacheKey: entry.cacheKey,
    remote: entry.remote,
    inputs,
  };
}

/** Every transform that produced a given state path, newest first. */
export function transformsFor(entries: LogEntry[], path: string): TransformDetail[] {
  return entries.filter((e) => e.write === path).reverse().map(transformInputs);
}
