/**
 * The browser's own file dialogs behind the transport's optional `pickFile` and
 * `saveFile`: a page has no editor to ask, so it asks the browser the way the rest
 * of the app already does — a hidden `<input type="file">` for reading, and an
 * object URL on a `download` link for writing.
 */
import type { Transport } from '@gba-kit/debug-ui';

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
    // a cancelled dialog fires nothing in most browsers, so the input is left to be collected with the page
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      void file.arrayBuffer().then((buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }));
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
