// @vitest-environment jsdom
/**
 * The browser's file dialogs behind the transport's `pickFile` and `saveFile`, and the
 * save-state bar over them: the bar holds every button disabled while an action runs, so
 * what matters most is that a dialog the user dismissed answers as surely as one they
 * chose a file in.
 */
import { MAX_SAVE_FILE_SIZE, type StateBody } from '@gba-kit/debug-core/protocol';
import { SaveStateDrawer, type Transport } from '@gba-kit/debug-ui';
import { act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pickFile, saveFile } from '../session/file-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILTERS = { 'Save files': ['sav'] };
/** What the save-state bar asks with, and what the tests here that do not care about it pass. */
const OPEN = { title: 'Import a .sav file', filters: FILTERS, maxBytes: MAX_SAVE_FILE_SIZE };

/**
 * The page as a browser too old for the `cancel` event: `pickFile` falls back to watching
 * the focus there, and jsdom is modern enough that the fallback would not otherwise arm.
 */
function withoutCancelEvent<T>(body: () => T): T {
  let owner: object | null = document.createElement('input');
  while (owner && !Object.getOwnPropertyDescriptor(owner, 'oncancel')) {
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  expect(owner, 'jsdom no longer defines `oncancel`, so this fixture pretends nothing').not.toBeNull();
  const holder = owner as object;
  const descriptor = Object.getOwnPropertyDescriptor(holder, 'oncancel')!;
  delete (holder as Record<string, unknown>).oncancel;
  try {
    return body();
  } finally {
    Object.defineProperty(holder, 'oncancel', descriptor);
  }
}

/** The hidden input `pickFile` put in the page, once the dialog it opened is up. */
function dialogInput(): HTMLInputElement {
  const input = document.querySelector('input[type=file]');
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

/** A file the dialog chose, as the browser hands it over. */
function chose(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
}

describe('picking a .sav in a browser', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('answers with the file the dialog chose, and takes the input back out of the page', async () => {
    const picked = pickFile(OPEN);
    chose(dialogInput(), new File([Uint8Array.of(1, 2, 3)], 'Klonoa (USA).sav'));
    expect(await picked).toEqual({ name: 'Klonoa (USA).sav', bytes: Uint8Array.of(1, 2, 3) });
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('answers a dismissed dialog too, rather than leaving the caller waiting forever', async () => {
    const picked = pickFile(OPEN);
    dialogInput().dispatchEvent(new Event('cancel'));
    expect(await picked).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('answers when the page takes the focus back with nothing chosen, for a browser without `cancel`', async () => {
    vi.useFakeTimers();
    try {
      const picked = withoutCancelEvent(() => pickFile(OPEN));
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await picked).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a file that arrives with the focus win, since a dialog that chose one is not a dismissal', async () => {
    vi.useFakeTimers();
    try {
      const picked = withoutCancelEvent(() => pickFile(OPEN));
      const input = dialogInput();
      Object.defineProperty(input, 'files', { configurable: true, value: [new File([Uint8Array.of(7)], 'a.sav')] });
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await picked).toEqual({ name: 'a.sav', bytes: Uint8Array.of(7) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting when the page takes the focus back with the dialog still open', async () => {
    // switching to another app and back raises a focus on the page, and the user is still
    // choosing: a browser with `cancel` says when the dialog really ended, so nothing guesses
    vi.useFakeTimers();
    try {
      const picked = pickFile(OPEN);
      const input = dialogInput();
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(1000);
      chose(input, new File([Uint8Array.of(7)], 'a.sav'));
      expect(await picked).toEqual({ name: 'a.sav', bytes: Uint8Array.of(7) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the file cannot be read, rather than never answering at all', async () => {
    const picked = pickFile(OPEN);
    const input = dialogInput();
    const unreadable = {
      name: 'gone.sav',
      size: 512,
      arrayBuffer: () => Promise.reject(new Error('the volume went away')),
    };
    Object.defineProperty(input, 'files', { configurable: true, value: [unreadable] });
    input.dispatchEvent(new Event('change'));
    await expect(picked).rejects.toThrow('gone.sav could not be read: the volume went away');
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('turns a file too big to be a .sav away by its size, before reading a byte of it', async () => {
    const picked = pickFile({ ...OPEN, maxBytes: 1024 });
    const input = dialogInput();
    let read = false;
    const huge = {
      name: 'kleod.gba',
      size: 16 * 1024 * 1024,
      arrayBuffer: () => {
        read = true;
        return Promise.resolve(new ArrayBuffer(0));
      },
    };
    Object.defineProperty(input, 'files', { configurable: true, value: [huge] });
    input.dispatchEvent(new Event('change'));
    await expect(picked).rejects.toThrow('kleod.gba is 16777216 bytes; at most 1024 can be read here');
    expect(read).toBe(false);
  });

  it('hands a file out under the name suggested for it', () => {
    const click = vi.fn();
    const created: HTMLAnchorElement[] = [];
    const element = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const node = element(tag) as HTMLElement;
      if (tag === 'a') {
        node.click = click;
        created.push(node as HTMLAnchorElement);
      }
      return node;
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:save');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      void saveFile({ title: 'x', suggestedName: 'save.sav', filters: FILTERS, bytes: Uint8Array.of(9) });
      expect(created[0]?.download).toBe('save.sav');
      expect(click).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

/** Enough of a transport for the save-state bar: the state it reads and the requests it makes. */
function fakeTransport(request: (command: string) => Promise<unknown>): Transport {
  return {
    state: { state: 'stopped', frame: 0 } as StateBody,
    onState: () => () => {},
    request: request as Transport['request'],
    pickFile,
    saveFile,
  } as unknown as Transport;
}

function labelsOf(root: HTMLElement): Array<[string, boolean]> {
  return [...root.querySelectorAll('button')].map((b) => [
    b.getAttribute('aria-label') ?? b.textContent ?? '',
    b.disabled,
  ]);
}

describe('the save-state bar over those dialogs', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(request: (command: string) => Promise<unknown>): Promise<void> {
    await act(async () => {
      root.render(createElement(SaveStateDrawer, { transport: fakeTransport(request), stopped: true }));
    });
  }

  /** The ⋯ menu's item, by the label it carries. */
  function menuItem(label: string): HTMLButtonElement {
    const item = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
    expect(item, label).toBeTruthy();
    return item as HTMLButtonElement;
  }

  it('comes back to life after a dismissed import, rather than staying disabled', async () => {
    await render(async (command) => (command === 'gba-kit/listStates' ? { states: [] } : {}));
    await act(async () => menuItem('Import from a .sav file').click());
    expect(labelsOf(host).some(([, disabled]) => disabled)).toBe(true);

    await act(async () => {
      dialogInput().dispatchEvent(new Event('cancel'));
    });
    expect(labelsOf(host).filter(([, disabled]) => disabled)).toEqual([]);
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('closes the \u22ef menu when Escape is pressed on the trigger that opened it', async () => {
    await render(async (command) => (command === 'gba-kit/listStates' ? { states: [] } : {}));
    const trigger = host.querySelector('[aria-haspopup=menu]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('turns a file too big to be a .sav away before it encodes any of it', async () => {
    const sent: string[] = [];
    await render(async (command) => {
      sent.push(command);
      return command === 'gba-kit/listStates' ? { states: [] } : {};
    });
    await act(async () => menuItem('Import from a .sav file').click());
    await act(async () => {
      chose(dialogInput(), new File([new Uint8Array(300_000)], 'kleod.gba'));
      // the file's bytes are read before anything else happens to them
      await Promise.resolve();
    });
    expect(host.textContent).toContain('kleod.gba is 300000 bytes');
    expect(sent).not.toContain('gba-kit/importSave');
  });
});
