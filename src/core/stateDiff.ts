/**
 * What changed between two state snapshots.
 *
 * "It worked a second ago" is the most common bug report a UI developer gets.
 * Comparing the tree before and after an interaction answers it directly,
 * without reading the log line by line.
 *
 * Pure.
 */
import type { StateNode } from './types';

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface StateChange {
  path: string;
  kind: ChangeKind;
  before?: string;
  after?: string;
}

/** Flatten a tree to path → value for the leaves that hold one. */
export function leaves(nodes: StateNode[], into = new Map<string, string>()): Map<string, string> {
  for (const node of nodes) {
    if (node.children?.length) leaves(node.children, into);
    else if (node.value !== undefined) into.set(node.id, node.value);
  }
  return into;
}

/** Leaf-level diff, ordered added → changed → removed, then by path. */
export function diffState(before: StateNode[], after: StateNode[]): StateChange[] {
  const a = leaves(before);
  const b = leaves(after);
  const changes: StateChange[] = [];

  for (const [path, value] of b) {
    const prior = a.get(path);
    if (prior === undefined) changes.push({ path, kind: 'added', after: value });
    else if (prior !== value) changes.push({ path, kind: 'changed', before: prior, after: value });
  }
  for (const [path, value] of a) {
    if (!b.has(path)) changes.push({ path, kind: 'removed', before: value });
  }

  const rank: Record<ChangeKind, number> = { added: 0, changed: 1, removed: 2 };
  return changes.sort((x, y) => rank[x.kind] - rank[y.kind] || x.path.localeCompare(y.path));
}
