/**
 * Reading and writing files from the panel.
 *
 * The File System Access API is what you want — a real save dialog, and a handle that
 * lets a second save overwrite the same file instead of littering the downloads
 * folder. It is not always available: **in a cross-origin iframe it is blocked by
 * permissions policy**, and the in-page console is exactly that (an extension iframe
 * on a fuuz.app page).
 *
 * So both paths exist and the caller does not have to care:
 *
 *   save   `showSaveFilePicker` → a download, which works everywhere
 *   open   `showOpenFilePicker` → a hidden `<input type="file">`, likewise
 *
 * The fallbacks are not degraded modes to apologise for; they are what makes these
 * buttons work in the docked console, where most of the use is.
 */

interface FileSystemWritable { write(data: string): Promise<void>; close(): Promise<void> }
interface FileHandle {
  name: string;
  createWritable(): Promise<FileSystemWritable>;
  getFile(): Promise<File>;
}
type Picker = {
  showSaveFilePicker?(opts: unknown): Promise<FileHandle>;
  showOpenFilePicker?(opts: unknown): Promise<FileHandle[]>;
};

export interface SaveOutcome {
  ok: boolean;
  /** How it was written, so the UI can say "downloaded" rather than implying a path. */
  how: 'picker' | 'download';
  name?: string;
  /** Kept so a second save can overwrite the same file. */
  handle?: unknown;
  error?: string;
}

/**
 * Write text to a file.
 *
 * `handle` reuses a previous save's destination — the difference between Save and Save
 * As, and the reason an iterative edit does not produce `query (3).json`.
 */
export async function saveText(
  text: string,
  suggestedName: string,
  types: readonly string[],
  handle?: unknown
): Promise<SaveOutcome> {
  const picker = window as unknown as Picker;

  if (handle) {
    try {
      const existing = handle as FileHandle;
      const writable = await existing.createWritable();
      await writable.write(text);
      await writable.close();
      return { ok: true, how: 'picker', name: existing.name, handle };
    } catch (e) {
      // A revoked or stale handle falls through to a fresh pick rather than failing.
      if (isAbort(e)) return { ok: false, how: 'picker', error: 'Cancelled.' };
    }
  }

  if (typeof picker.showSaveFilePicker === 'function') {
    try {
      const fresh = await picker.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Fuuz Dev Console', accept: { 'application/json': types } }],
      });
      const writable = await fresh.createWritable();
      await writable.write(text);
      await writable.close();
      return { ok: true, how: 'picker', name: fresh.name, handle: fresh };
    } catch (e) {
      if (isAbort(e)) return { ok: false, how: 'picker', error: 'Cancelled.' };
      // Anything else — a permissions-policy block in the docked iframe — falls
      // through to the download, which is the whole point of having two paths.
    }
  }

  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, how: 'download', name: suggestedName };
  } catch (e) {
    return { ok: false, how: 'download', error: e instanceof Error ? e.message : String(e) };
  }
}

export interface OpenOutcome {
  ok: boolean;
  text?: string;
  name?: string;
  handle?: unknown;
  error?: string;
}

/** Read a file the user chooses. */
export async function openText(types: readonly string[]): Promise<OpenOutcome> {
  const picker = window as unknown as Picker;

  if (typeof picker.showOpenFilePicker === 'function') {
    try {
      const [handle] = await picker.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'Script or query', accept: { 'application/json': types } }],
      });
      if (handle) {
        const file = await handle.getFile();
        return { ok: true, text: await file.text(), name: handle.name, handle };
      }
    } catch (e) {
      if (isAbort(e)) return { ok: false, error: 'Cancelled.' };
      // Blocked by policy in the docked console — fall through.
    }
  }

  return new Promise<OpenOutcome>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = types.join(',');
    /*
     * There is no cancel event for a file input.
     *
     * `cancel` is not universally fired, so a dismissed dialog would leave this promise
     * pending forever and the button dead until reload. Resolving on window focus is
     * the reliable signal that the dialog closed.
     */
    const settle = (outcome: OpenOutcome) => {
      window.removeEventListener('focus', onFocus);
      resolve(outcome);
    };
    const onFocus = () => setTimeout(() => { if (!input.files?.length) settle({ ok: false, error: 'Cancelled.' }); }, 300);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { settle({ ok: false, error: 'Cancelled.' }); return; }
      void file.text().then(
        (text) => settle({ ok: true, text, name: file.name }),
        (e) => settle({ ok: false, error: e instanceof Error ? e.message : String(e) })
      );
    });
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';
