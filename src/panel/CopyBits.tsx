import { useState } from 'react';

/**
 * Copy the path, or copy the value.
 *
 * The path is what you paste into a transform; the value is what you paste into a
 * bug report. Two different payloads, so two buttons — and a row that has no
 * referenceable path (our own synthetic buckets) shows only the value, rather than
 * offering a button that copies something the runtime cannot resolve.
 *
 * Shared rather than duplicated: the same affordance is wanted on the state tree,
 * on the Screen tab's context rows, and on every element property, and three
 * copies would drift.
 */
export function CopyBits({ path, value, dense }: {
  /** Already-built transform path, e.g. `$components.Form1.disabled`. */
  path?: string;
  /** Pretty-printed JSON to copy, when there is a value worth copying. */
  value?: string;
  /** Tighter spacing, for use inside a property row. */
  dense?: boolean;
}) {
  const [done, setDone] = useState('');
  const copy = (text: string, what: string) => (ev: React.MouseEvent) => {
    ev.stopPropagation();
    void navigator.clipboard.writeText(text).then(
      () => { setDone(what); setTimeout(() => setDone(''), 1200); },
      () => undefined
    );
  };
  if (!path && !value) return null;
  return (
    <span className={`copybits ${dense ? 'dense' : ''}`}>
      {path && (
        <button className={`copybit ${done === 'p' ? 'ok' : ''}`} title={`Copy ${path}`}
          onClick={copy(path, 'p')}>{done === 'p' ? '✓' : '$'}</button>
      )}
      {value !== undefined && (
        <button className={`copybit ${done === 'v' ? 'ok' : ''}`} title="Copy the value as JSON"
          onClick={copy(value, 'v')}>{done === 'v' ? '✓' : '{ }'}</button>
      )}
    </span>
  );
}
