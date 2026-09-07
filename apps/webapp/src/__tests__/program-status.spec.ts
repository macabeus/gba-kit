/** The toolbar's word on the ELF: silent when it matches the ROM, loud when it describes another one. */
import { describe, expect, it } from 'vitest';

import { programStatus } from '../pages/debug/program-status';
import { bootSession, fixture } from './fixtures';

describe('programStatus', () => {
  it('says nothing for an ELF that matches the ROM', async () => {
    const session = await bootSession('thumb-O0');
    expect(programStatus(session.program)).toBeNull();
  });

  it('says there is no ELF', async () => {
    const session = await bootSession('thumb-O0', undefined, { elf: null });
    expect(programStatus(session.program)).toEqual({ text: 'no ELF' });
  });

  it('flags an ELF kept from another ROM, with the contradiction as the detail', async () => {
    const session = await bootSession('thumb-O2', undefined, { elf: fixture('thumb-O0').elf });
    expect(programStatus(session.program)).toEqual({
      text: 'ELF does not match ROM',
      detail: expect.stringContaining('extends past the end of the ROM'),
    });
  });
});
