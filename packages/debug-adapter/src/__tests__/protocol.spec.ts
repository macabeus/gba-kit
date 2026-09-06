/** A DAP client imports the protocol vocabulary from the adapter, which re-exports it. */
import { describe, expect, it } from 'vitest';

import { LOG, STREAM, entryCount } from '../protocol.js';

describe('protocol re-export', () => {
  it('hands out the stream framing, the log limits and the argument helpers', () => {
    expect(STREAM.magic).toBe(0x4b47);
    expect(LOG.max).toBe(20_000);
    expect(entryCount(undefined, LOG.traceDefault)).toBe(LOG.traceDefault);
  });
});
