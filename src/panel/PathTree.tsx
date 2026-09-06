import { useState } from 'react';
import { pathFor, previewOf, type PathRoot } from '../core/pathInsert';
import { accepts, subtreeAccepts, typeOf } from '../core/functionPalette';

/**
 * The payload or context, browsable — and every row drops its path into the script.
 *
 * The boxes are still editable text, because sometimes you need to change the data. But
 * *reading* a path out of raw JSON meant working it out by eye and typing it, and a typo
 * there produces a silent null rather than an error — the most common way a Fuuz expression
 * goes wrong.
 *
 * Clicking a row inserts `$state.orderId` at the caret. Clicking a **branch** inserts the
 * branch's own path rather than expanding, because `$state` and `$.lines` are useful paths
 * in their own right; the caret toggles expansion. Two targets, so neither gesture has to
 * guess at intent.
 */
export function PathTree({ value, root, onPick, depth = 0, segments = [], label, suits }: {
  value: unknown;
  /** `document` for the payload (`$.x`), `bindings` for the context (`$x`). */
  root: PathRoot;
  onPick: (path: string) => void;
  depth?: number;
  segments?: (string | number)[];
  label?: string;
  /**
   * The type a chosen function wants, so rows that do not suit it can be dimmed.
   *
   * Advisory only — JSONata coerces, so this greys out rather than disables. A branch stays lit
   * when anything *inside* it fits, or the value you were looking for would be hidden behind the
   * filter meant to find it.
   */
  suits?: string;
}) {
  // Open to two levels: deep enough to see an element's own keys, shallow enough that a
  // large capture does not render a thousand rows on arrival.
  const [open, setOpen] = useState(depth < 2);

  const entries = childrenOf(value);
  const path = pathFor(root, segments);
  const isBranch = entries !== undefined;
  const fits = !suits || accepts(suits, typeOf(value)) || subtreeAccepts(value, suits);

  return (
    <>
      {label !== undefined && (
        <div className={`pathrow ${fits ? '' : 'unfit'}`} style={{ paddingLeft: 6 + depth * 12 }}
          title={fits ? undefined : `A ${typeOf(value)} — probably not what this function wants`}>
          <span className="caret" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
            {isBranch ? (open ? '▾' : '▸') : ''}
          </span>
          {/* The label is the insert target. `title` carries the exact path, so what a
              click will do is checkable before making it. */}
          <span className="pathkey" title={`Insert ${path}`} onClick={() => onPick(path)}>{label}</span>
          <span className="pathval" title={`Insert ${path}`} onClick={() => onPick(path)}>
            {previewOf(value)}
          </span>
        </div>
      )}

      {(open || label === undefined) && entries?.map(([key, child]) => (
        <PathTree
          key={String(key)}
          value={child}
          root={root}
          onPick={onPick}
          depth={label === undefined ? depth : depth + 1}
          segments={[...segments, key]}
          label={typeof key === 'number' ? `[${key}]` : key}
          suits={suits}
        />
      ))}
    </>
  );
}

/**
 * A value's children as `[key, value]` pairs, or undefined for a leaf.
 *
 * Array indices stay numbers so the path builder can render them as `[0]` — JSONata reads
 * `a.0` as a field literally named `0`, which resolves to nothing.
 */
function childrenOf(value: unknown): [string | number, unknown][] | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    // Bounded: a thousand-row array is not something you browse, and rendering it would
    // freeze the pane. The path to the array itself still works.
    return value.slice(0, 100).map((v, i) => [i, v]);
  }
  return Object.entries(value as Record<string, unknown>);
}
