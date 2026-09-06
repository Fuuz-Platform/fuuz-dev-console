/**
 * Answer "how was this value produced?" by walking the log backwards.
 *
 * Each entry declares the path it wrote and the paths its expression read. That
 * is a dependency graph: the entry that set `components.IntakePrepare.url` read
 * `$doc`, which was written by the entry that read `$mine`, which read the user
 * id and the table rows. Walking those edges yields the chain of writes behind
 * a value — which is the whole point of the console, and is not something the
 * browser's own console can tell you.
 *
 * Pure: no VS Code, no I/O.
 */
import type { LogEntry } from './types';

/** Depth guard, so a pathological expression graph can't stall the panel. */
const MAX_DEPTH = 24;

/**
 * Does a write to `writePath` satisfy a read of `readPath`?
 *
 * Exactly, or by ancestry: writing `components.Form.data` also produces
 * `components.Form.data.assetCollection`. The reverse (writing a leaf, reading
 * its parent) also counts — a write into an object mutates the object.
 */
export function writeSatisfiesRead(writePath: string, readPath: string): boolean {
  if (!writePath || !readPath) return false;
  if (writePath === readPath) return true;
  return readPath.startsWith(writePath + '.') || writePath.startsWith(readPath + '.');
}

/** The newest entry before `beforeSeq` whose write satisfies `path`, if any. */
function lastWriterOf(entries: LogEntry[], path: string, beforeSeq: number): LogEntry | undefined {
  let best: LogEntry | undefined;
  for (const e of entries) {
    if (e.seq >= beforeSeq) break;
    if (writeSatisfiesRead(e.write, path)) best = e;
  }
  return best;
}

/**
 * The ordered chain of entries that produced the current value at `path`,
 * oldest first — the sequence the trace timeline numbers 1..n.
 *
 * `entries` must be sorted by `seq` ascending.
 */
export function provenanceFor(entries: LogEntry[], path: string): string[] {
  const head = [...entries].reverse().find((e) => writeSatisfiesRead(e.write, path));
  if (!head) return [];

  const collected = new Map<string, LogEntry>();
  const visit = (entry: LogEntry, depth: number): void => {
    if (depth > MAX_DEPTH || collected.has(entry.id)) return;
    collected.set(entry.id, entry);
    for (const read of entry.reads) {
      const producer = lastWriterOf(entries, read, entry.seq);
      if (producer) visit(producer, depth + 1);
    }
  };
  visit(head, 0);

  return [...collected.values()].sort((a, b) => a.seq - b.seq).map((e) => e.id);
}

/**
 * Provenance for every written path in one pass, so building the tree doesn't
 * re-walk the graph per node.
 */
export function provenanceIndex(entries: LogEntry[]): Map<string, string[]> {
  const paths = new Set(entries.map((e) => e.write).filter(Boolean));
  const index = new Map<string, string[]>();
  for (const path of paths) index.set(path, provenanceFor(entries, path));
  return index;
}
