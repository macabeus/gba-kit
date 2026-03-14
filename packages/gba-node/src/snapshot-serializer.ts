/**
 * GbaSnapshot JSON Serializer
 *
 * Converts GbaSnapshot (with TypedArrays) to/from plain JSON objects
 * using base64 encoding for binary data.
 */
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

/** Encode a TypedArray to base64 string */
function typedArrayToBase64(arr: Uint8Array | Uint32Array | Int8Array): string {
  const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return Buffer.from(bytes).toString('base64');
}

/** Decode a base64 string to a buffer, then wrap in the target TypedArray constructor */
function base64ToUint8Array(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function base64ToUint32Array(b64: string): Uint32Array {
  const buf = Buffer.from(b64, 'base64');
  return new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function base64ToInt8Array(b64: string): Int8Array {
  const buf = Buffer.from(b64, 'base64');
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function serializeSnapshot(snap: GbaSnapshot): any {
  return {
    version: snap.version,
    cpu: {
      registers: typedArrayToBase64(snap.cpu.registers),
      cpsr: snap.cpu.cpsr,
      bankedSP: typedArrayToBase64(snap.cpu.bankedSP),
      bankedLR: typedArrayToBase64(snap.cpu.bankedLR),
      fiqBankedR8to12: typedArrayToBase64(snap.cpu.fiqBankedR8to12),
      usrBankedR8to12: typedArrayToBase64(snap.cpu.usrBankedR8to12),
      spsr: typedArrayToBase64(snap.cpu.spsr),
      halted: snap.cpu.halted,
      haltedBySWI: snap.cpu.haltedBySWI,
    },
    currentScanline: snap.currentScanline,
    inIrqHandler: snap.inIrqHandler,
    scheduler: {
      currentCycle: snap.scheduler.currentCycle,
      events: snap.scheduler.events,
    },
    interrupts: snap.interrupts,
    timers: snap.timers,
    dma: snap.dma,
    input: snap.input,
    bus: {
      ewram: typedArrayToBase64(snap.bus.ewram),
      iwram: typedArrayToBase64(snap.bus.iwram),
      palette: typedArrayToBase64(snap.bus.palette),
      vram: typedArrayToBase64(snap.bus.vram),
      oam: typedArrayToBase64(snap.bus.oam),
      sram: typedArrayToBase64(snap.bus.sram),
      mmioRegisters: typedArrayToBase64(snap.bus.mmioRegisters),
      hasSram: snap.bus.hasSram,
      waitcnt: snap.bus.waitcnt,
      postflg: snap.bus.postflg,
      lastBiosRead: snap.bus.lastBiosRead,
      eeprom: {
        data: typedArrayToBase64(snap.bus.eeprom.data),
        addrBits: snap.bus.eeprom.addrBits,
        state: snap.bus.eeprom.state,
        command: snap.bus.eeprom.command,
        address: snap.bus.eeprom.address,
        bitBuffer: snap.bus.eeprom.bitBuffer,
        bitsReceived: snap.bus.eeprom.bitsReceived,
        sendBuffer: snap.bus.eeprom.sendBuffer,
        sendPos: snap.bus.eeprom.sendPos,
      },
    },
    ppu: {
      framebuffer: typedArrayToBase64(snap.ppu.framebuffer),
      bg2RefX: snap.ppu.bg2RefX,
      bg2RefY: snap.ppu.bg2RefY,
      bg3RefX: snap.ppu.bg3RefX,
      bg3RefY: snap.ppu.bg3RefY,
      bg2RefLatched: snap.ppu.bg2RefLatched,
      bg3RefLatched: snap.ppu.bg3RefLatched,
    },
    apu: snap.apu
      ? {
          ...snap.apu,
          dsA: {
            ...snap.apu.dsA,
            buffer: typedArrayToBase64(snap.apu.dsA.buffer),
          },
          dsB: {
            ...snap.apu.dsB,
            buffer: typedArrayToBase64(snap.apu.dsB.buffer),
          },
          ch3: {
            ...snap.apu.ch3,
            waveRam: typedArrayToBase64(snap.apu.ch3.waveRam),
          },
        }
      : undefined,
  };
}

export function deserializeSnapshot(data: any): GbaSnapshot {
  return {
    version: data.version,
    cpu: {
      registers: base64ToUint32Array(data.cpu.registers),
      cpsr: data.cpu.cpsr,
      bankedSP: base64ToUint32Array(data.cpu.bankedSP),
      bankedLR: base64ToUint32Array(data.cpu.bankedLR),
      fiqBankedR8to12: base64ToUint32Array(data.cpu.fiqBankedR8to12),
      usrBankedR8to12: base64ToUint32Array(data.cpu.usrBankedR8to12),
      spsr: base64ToUint32Array(data.cpu.spsr),
      halted: data.cpu.halted,
      haltedBySWI: data.cpu.haltedBySWI,
    },
    currentScanline: data.currentScanline,
    inIrqHandler: data.inIrqHandler,
    scheduler: data.scheduler,
    interrupts: data.interrupts,
    timers: data.timers,
    dma: data.dma,
    input: data.input,
    bus: {
      ewram: base64ToUint8Array(data.bus.ewram),
      iwram: base64ToUint8Array(data.bus.iwram),
      palette: base64ToUint8Array(data.bus.palette),
      vram: base64ToUint8Array(data.bus.vram),
      oam: base64ToUint8Array(data.bus.oam),
      sram: base64ToUint8Array(data.bus.sram),
      mmioRegisters: base64ToUint8Array(data.bus.mmioRegisters),
      hasSram: data.bus.hasSram,
      waitcnt: data.bus.waitcnt,
      postflg: data.bus.postflg,
      lastBiosRead: data.bus.lastBiosRead,
      eeprom: {
        data: base64ToUint8Array(data.bus.eeprom.data),
        addrBits: data.bus.eeprom.addrBits,
        state: data.bus.eeprom.state,
        command: data.bus.eeprom.command,
        address: data.bus.eeprom.address,
        bitBuffer: data.bus.eeprom.bitBuffer,
        bitsReceived: data.bus.eeprom.bitsReceived,
        sendBuffer: data.bus.eeprom.sendBuffer,
        sendPos: data.bus.eeprom.sendPos,
      },
    },
    ppu: {
      framebuffer: base64ToUint32Array(data.ppu.framebuffer),
      bg2RefX: data.ppu.bg2RefX,
      bg2RefY: data.ppu.bg2RefY,
      bg3RefX: data.ppu.bg3RefX,
      bg3RefY: data.ppu.bg3RefY,
      bg2RefLatched: data.ppu.bg2RefLatched,
      bg3RefLatched: data.ppu.bg3RefLatched,
    },
    apu: data.apu
      ? {
          ...data.apu,
          dsA: {
            ...data.apu.dsA,
            buffer: base64ToInt8Array(data.apu.dsA.buffer),
          },
          dsB: {
            ...data.apu.dsB,
            buffer: base64ToInt8Array(data.apu.dsB.buffer),
          },
          ch3: {
            ...data.apu.ch3,
            waveRam: base64ToUint8Array(data.apu.ch3.waveRam),
          },
        }
      : (undefined as never),
  };
}
