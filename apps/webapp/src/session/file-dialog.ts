/**
 * The browser's own file dialogs behind the transport's optional `pickFile` and
 * `saveFile`: a page has no editor to ask, so it asks the browser the way the rest
 * of the app already does — a hidden `<input type="file">` for reading, and an
 * object URL on a `download` link for writing.
 */
import { type Transport, fileTooBig } from '@gba-kit/debug-ui';

/** How long after the page takes the focus back a file may still arrive, before the dialog counts as dismissed. */
const DISMISS_GRACE = 500;

/**
 * Whether this browser reports a dismissed file dialog with a `cancel` event, which
 * every browser since 2023 does. Asked of the element rather than inline, so that
 * `input` is not narrowed to a type that has one by the question itself.
 */
function reportsCancel(input: HTMLInputElement): boolean {
  return 'oncancel' in input;
}

/** `{ 'Save files': ['sav'] }` as an `accept` attribute. */
function acceptOf(filters: Record<string, string[]>): string {
  return Object.values(filters)
    .flat()
    .map((extension) => `.${extension}`)
    .join(',');
}

export const pickFile: NonNullable<Transport['pickFile']> = ({ filters, maxBytes }) =>
  new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptOf(filters);
    input.style.display = 'none';

    /**
     * Every way the dialog and the read that follows it can end settles the promise once
     * and takes the input back out of the page: a caller holds its buttons disabled until
     * this answers, so a dialog the user dismissed — or a file the browser turned out not
     * to be able to read — has to answer as surely as one they chose a file in.
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
      // `size` is known before a byte is read, so a mis-picked ROM never reaches memory
      if (file.size > maxBytes) {
        reject(new Error(fileTooBig(file.name, file.size, maxBytes)));
        return;
      }
      file.arrayBuffer().then(
        (buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }),
        // a file on a volume that went away, or one replaced between the pick and the read
        (err: Error) => reject(new Error(`${file.name} could not be read: ${err.message}`)),
      );
    };

    input.addEventListener('change', () => answer(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => answer(null));
    if (!reportsCancel(input)) {
      // a browser too old for `cancel` says nothing at all when the dialog is dismissed, and
      // the page taking the focus back is the only other sign of it — a moment later, so that
      // a dialog that did choose a file has put it in `input.files` by the time this looks.
      // Only such a browser arms it: the page can take the focus back with the dialog still
      // open, and then this would answer for a user who is still choosing.
      window.addEventListener('focus', () => setTimeout(() => answer(input.files?.[0] ?? null), DISMISS_GRACE), {
        once: true,
      });
    }
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
