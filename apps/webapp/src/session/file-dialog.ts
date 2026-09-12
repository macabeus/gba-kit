/**
 * The browser's own file dialogs behind the transport's optional `pickFile` and
 * `saveFile`: a page has no editor to ask, so it asks the browser the way the rest
 * of the app already does — a hidden `<input type="file">` for reading, and an
 * object URL on a `download` link for writing.
 */
import type { Transport } from '@gba-kit/debug-ui';

/** How long after the page takes the focus back a file may still arrive, before the dialog counts as dismissed. */
const DISMISS_GRACE = 500;

/** `{ 'Save files': ['sav'] }` as an `accept` attribute. */
function acceptOf(filters: Record<string, string[]>): string {
  return Object.values(filters)
    .flat()
    .map((extension) => `.${extension}`)
    .join(',');
}

export const pickFile: NonNullable<Transport['pickFile']> = ({ filters }) =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptOf(filters);
    input.style.display = 'none';

    /**
     * Every way the dialog can end settles the promise once and takes the input back out
     * of the page: a caller holds its buttons disabled until this answers, so a dialog
     * the user dismissed has to answer as surely as one they chose a file in.
     */
    let settled = false;
    const answer = (file: File | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      void file.arrayBuffer().then((buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }));
    };

    input.addEventListener('change', () => answer(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => answer(null));
    // a browser too old for `cancel` says nothing at all when the dialog is dismissed, and
    // the page taking the focus back is the only other sign of it — a moment later, so that
    // a dialog that did choose a file has put it in `input.files` by the time this looks
    window.addEventListener('focus', () => setTimeout(() => answer(input.files?.[0] ?? null), DISMISS_GRACE), {
      once: true,
    });
    document.body.append(input);
    input.click();
  });

export const saveFile: NonNullable<Transport['saveFile']> = ({ suggestedName, bytes }) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  // the browser takes it from here: there is no telling whether the user kept it
  return Promise.resolve(true);
};
