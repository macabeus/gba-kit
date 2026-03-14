import { describe, expect, it } from 'vitest';

import { GbaMemory } from '../memory.js';

describe('GbaMemory', () => {
  describe('region dispatch', () => {
    it('reads and writes EWRAM (0x02000000)', () => {
      const mem = new GbaMemory();
      mem.write32(0x02000000, 0xdeadbeef);
      expect(mem.read32(0x02000000)).toBe(0xdeadbeef);
    });

    it('reads and writes IWRAM (0x03000000)', () => {
      const mem = new GbaMemory();
      mem.write16(0x03000000, 0xabcd);
      expect(mem.read16(0x03000000)).toBe(0xabcd);
    });

    it('reads and writes MMIO (0x04000000)', () => {
      const mem = new GbaMemory();
      mem.write16(0x04000000, 0x1234);
      expect(mem.read16(0x04000000)).toBe(0x1234);
    });

    it('reads and writes PALETTE (0x05000000)', () => {
      const mem = new GbaMemory();
      mem.write16(0x05000100, 0x7fff);
      expect(mem.read16(0x05000100)).toBe(0x7fff);
    });

    it('reads and writes VRAM (0x06000000)', () => {
      const mem = new GbaMemory();
      mem.write32(0x06000004, 0x12345678);
      expect(mem.read32(0x06000004)).toBe(0x12345678);
    });

    it('reads and writes OAM (0x07000000)', () => {
      const mem = new GbaMemory();
      mem.write16(0x07000010, 0x0200);
      expect(mem.read16(0x07000010)).toBe(0x0200);
    });

    it('reads and writes ROM (0x08000000)', () => {
      const mem = new GbaMemory();
      mem.write32(0x08000000, 0x11223344);
      expect(mem.read32(0x08000000)).toBe(0x11223344);
    });

    it('returns 0 for unmapped regions', () => {
      const mem = new GbaMemory();
      expect(mem.read32(0x01000000)).toBe(0);
      expect(mem.read8(0xff000000)).toBe(0);
    });

    it('writes to unmapped regions are silently ignored', () => {
      const mem = new GbaMemory();
      mem.write32(0x01000000, 0xdeadbeef);
      expect(mem.read32(0x01000000)).toBe(0);
    });
  });

  describe('byte access (read8/write8)', () => {
    it('reads individual bytes in little-endian order', () => {
      const mem = new GbaMemory();
      mem.write32(0x02000000, 0x04030201);
      expect(mem.read8(0x02000000)).toBe(0x01);
      expect(mem.read8(0x02000001)).toBe(0x02);
      expect(mem.read8(0x02000002)).toBe(0x03);
      expect(mem.read8(0x02000003)).toBe(0x04);
    });

    it('writes individual bytes', () => {
      const mem = new GbaMemory();
      mem.write8(0x02000000, 0xaa);
      mem.write8(0x02000001, 0xbb);
      expect(mem.read16(0x02000000)).toBe(0xbbaa);
    });

    it('masks values to 8 bits', () => {
      const mem = new GbaMemory();
      mem.write8(0x02000000, 0x1ff);
      expect(mem.read8(0x02000000)).toBe(0xff);
    });
  });

  describe('halfword access (read16/write16)', () => {
    it('reads 16-bit values little-endian', () => {
      const mem = new GbaMemory();
      mem.write8(0x02000000, 0x34);
      mem.write8(0x02000001, 0x12);
      expect(mem.read16(0x02000000)).toBe(0x1234);
    });

    it('aligns halfword reads', () => {
      const mem = new GbaMemory();
      mem.write16(0x02000000, 0xaabb);
      // Unaligned read rotates on ARMv4T
      const val = mem.read16(0x02000001);
      // (0xaabb >>> 8) | (0xaabb << 24) = 0xbb0000aa >>> 0
      expect(val >>> 0).toBe(((0xaabb >>> 8) | (0xaabb << 24)) >>> 0);
    });

    it('masks values to 16 bits', () => {
      const mem = new GbaMemory();
      mem.write16(0x02000000, 0x1ffff);
      expect(mem.read16(0x02000000)).toBe(0xffff);
    });
  });

  describe('word access (read32/write32)', () => {
    it('reads and writes 32-bit values', () => {
      const mem = new GbaMemory();
      mem.write32(0x02000000, 0x12345678);
      expect(mem.read32(0x02000000)).toBe(0x12345678);
    });

    it('rotates on unaligned word read', () => {
      const mem = new GbaMemory();
      mem.write32(0x02000000, 0x04030201);
      // Reading from addr+1 (misaligned by 1 byte) rotates by 8
      const val = mem.read32(0x02000001);
      expect(val >>> 0).toBe(0x01040302);
    });

    it('handles unsigned values above 0x7fffffff', () => {
      const mem = new GbaMemory();
      mem.write32(0x02000000, 0xffffffff);
      expect(mem.read32(0x02000000) >>> 0).toBe(0xffffffff);
    });
  });

  describe('EWRAM mirroring', () => {
    it('mirrors EWRAM within 256KB', () => {
      const mem = new GbaMemory();
      mem.write32(0x02000000, 0xdeadbeef);
      // EWRAM is 256KB (0x40000), address wraps with mask 0x3ffff
      expect(mem.read32(0x02040000)).toBe(0xdeadbeef);
    });
  });

  describe('VRAM mirroring', () => {
    it('mirrors upper VRAM back by 0x8000', () => {
      const mem = new GbaMemory();
      mem.write32(0x06010000, 0x12345678);
      // Address 0x06018000 should mirror to 0x06010000
      expect(mem.read32(0x06018000)).toBe(0x12345678);
    });
  });

  describe('loadBytes()', () => {
    it('loads a byte array into memory', () => {
      const mem = new GbaMemory();
      const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      mem.loadBytes(0x08000000, data);
      expect(mem.read32(0x08000000)).toBe(0x04030201);
    });

    it('handles cross-region loads gracefully', () => {
      const mem = new GbaMemory();
      // Loading into unmapped region does nothing
      const data = new Uint8Array([0xff]);
      mem.loadBytes(0x01000000, data);
      expect(mem.read8(0x01000000)).toBe(0);
    });
  });

  describe('write logging', () => {
    it('records all writes', () => {
      const mem = new GbaMemory();
      mem.write8(0x02000000, 0xaa);
      mem.write16(0x02000002, 0xbbcc);
      mem.write32(0x02000004, 0xdeadbeef);

      const log = mem.getWriteLog();
      expect(log).toHaveLength(3);
      expect(log[0]).toEqual({ address: 0x02000000, size: 1, value: 0xaa });
      expect(log[1]).toEqual({ address: 0x02000002, size: 2, value: 0xbbcc });
      expect(log[2]).toEqual({ address: 0x02000004, size: 4, value: 0xdeadbeef });
    });

    it('records MMIO writes separately', () => {
      const mem = new GbaMemory();
      mem.write16(0x04000000, 0x1234);
      mem.write32(0x02000000, 0xdeadbeef);
      mem.write16(0x04000004, 0x5678);

      const mmioLog = mem.getMmioWriteLog();
      expect(mmioLog).toHaveLength(2);
      expect(mmioLog[0]).toEqual({ address: 0x04000000, size: 2, value: 0x1234 });
      expect(mmioLog[1]).toEqual({ address: 0x04000004, size: 2, value: 0x5678 });
    });

    it('resetWriteLog() clears logs but keeps memory', () => {
      const mem = new GbaMemory();
      mem.write32(0x02000000, 0xdeadbeef);
      mem.resetWriteLog();

      expect(mem.getWriteLog()).toHaveLength(0);
      expect(mem.getMmioWriteLog()).toHaveLength(0);
      expect(mem.read32(0x02000000)).toBe(0xdeadbeef);
    });
  });

  describe('reset()', () => {
    it('zeros all writable memory and clears logs', () => {
      const mem = new GbaMemory();
      mem.write32(0x02000000, 0xdeadbeef);
      mem.write32(0x03000000, 0xcafebabe);
      mem.reset();

      expect(mem.read32(0x02000000)).toBe(0);
      expect(mem.read32(0x03000000)).toBe(0);
      expect(mem.getWriteLog()).toHaveLength(0);
    });

    it('preserves ROM contents', () => {
      const mem = new GbaMemory();
      mem.loadBytes(0x08000000, new Uint8Array([0x01, 0x02, 0x03, 0x04]));
      mem.reset();

      expect(mem.read32(0x08000000)).toBe(0x04030201);
    });
  });
});
