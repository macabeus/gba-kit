/**
 * GBA Emulator — Hardware-level Types
 *
 * Types specific to GBA hardware subsystems. CPU-level types
 * live in shared/arm-emulator/types.ts.
 */

// ─── Timing Constants ─────────────────────────────────────────────────

/** ARM7TDMI clock frequency: 2^24 Hz ≈ 16.78 MHz */
export const CPU_FREQ = 16_777_216;

/** Cycles per scanline (visible + HBlank) */
export const CYCLES_PER_SCANLINE = 1232;

/** Number of visible scanlines */
export const VISIBLE_SCANLINES = 160;

/** Number of VBlank scanlines */
export const VBLANK_SCANLINES = 68;

/** Total scanlines per frame */
export const TOTAL_SCANLINES = VISIBLE_SCANLINES + VBLANK_SCANLINES; // 228

/** Cycles per frame */
export const CYCLES_PER_FRAME = CYCLES_PER_SCANLINE * TOTAL_SCANLINES; // 280,896

/** Visible portion of a scanline in cycles */
export const HDRAW_CYCLES = 960;

/** HBlank portion in cycles */
export const HBLANK_CYCLES = 272;

/** Target frame rate (Hz) */
export const FRAME_RATE = CPU_FREQ / CYCLES_PER_FRAME; // ~59.7275 Hz

// ─── Screen Dimensions ────────────────────────────────────────────────

export const SCREEN_WIDTH = 240;
export const SCREEN_HEIGHT = 160;

// ─── Event IDs ────────────────────────────────────────────────────────

/** Unique IDs for scheduled hardware events */
export const enum EventId {
  HBlank,
  HBlankEnd,
  VBlank,
  VBlankEnd,
  Timer0Overflow,
  Timer1Overflow,
  Timer2Overflow,
  Timer3Overflow,
  Dma0,
  Dma1,
  Dma2,
  Dma3,
  /** Sentinel — total count of event types */
  Count,
}

// ─── Interrupt Flags ──────────────────────────────────────────────────

export const enum IrqFlag {
  VBlank = 1 << 0,
  HBlank = 1 << 1,
  VCount = 1 << 2,
  Timer0 = 1 << 3,
  Timer1 = 1 << 4,
  Timer2 = 1 << 5,
  Timer3 = 1 << 6,
  Serial = 1 << 7,
  Dma0 = 1 << 8,
  Dma1 = 1 << 9,
  Dma2 = 1 << 10,
  Dma3 = 1 << 11,
  Keypad = 1 << 12,
  GamePak = 1 << 13,
}

// ─── DMA ──────────────────────────────────────────────────────────────

/** DMA start timing modes */
export const enum DmaStartTiming {
  Immediately = 0,
  VBlank = 1,
  HBlank = 2,
  Special = 3, // DMA1/2: Sound FIFO, DMA3: Video capture
}

/** DMA address control */
export const enum DmaAddrControl {
  Increment = 0,
  Decrement = 1,
  Fixed = 2,
  IncrementReload = 3,
}

// ─── Timer ────────────────────────────────────────────────────────────

/** Timer prescaler dividers */
export const TIMER_PRESCALERS = [1, 64, 256, 1024] as const;

// ─── Input ────────────────────────────────────────────────────────────

/** GBA button bit positions in KEYINPUT register (active-low) */
export const enum GbaButton {
  A = 0,
  B = 1,
  Select = 2,
  Start = 3,
  Right = 4,
  Left = 5,
  Up = 6,
  Down = 7,
  R = 8,
  L = 9,
}

// ─── MMIO Register Addresses ──────────────────────────────────────────

export const MMIO = {
  // Display
  DISPCNT: 0x04000000,
  DISPSTAT: 0x04000004,
  VCOUNT: 0x04000006,
  BG0CNT: 0x04000008,
  BG1CNT: 0x0400000a,
  BG2CNT: 0x0400000c,
  BG3CNT: 0x0400000e,
  BG0HOFS: 0x04000010,
  BG0VOFS: 0x04000012,
  BG1HOFS: 0x04000014,
  BG1VOFS: 0x04000016,
  BG2HOFS: 0x04000018,
  BG2VOFS: 0x0400001a,
  BG2PA: 0x04000020,
  BG2PB: 0x04000022,
  BG2PC: 0x04000024,
  BG2PD: 0x04000026,
  BG2X: 0x04000028,
  BG2Y: 0x0400002c,
  BG3PA: 0x04000030,
  BG3PB: 0x04000032,
  BG3PC: 0x04000034,
  BG3PD: 0x04000036,
  BG3X: 0x04000038,
  BG3Y: 0x0400003c,
  WIN0H: 0x04000040,
  WIN1H: 0x04000042,
  WIN0V: 0x04000044,
  WIN1V: 0x04000046,
  WININ: 0x04000048,
  WINOUT: 0x0400004a,
  MOSAIC: 0x0400004c,
  BLDCNT: 0x04000050,
  BLDALPHA: 0x04000052,
  BLDY: 0x04000054,

  // Sound
  SOUNDCNT_L: 0x04000080,
  SOUNDCNT_H: 0x04000082,
  SOUNDCNT_X: 0x04000084,
  SOUNDBIAS: 0x04000088,
  FIFO_A: 0x040000a0,
  FIFO_B: 0x040000a4,

  // DMA
  DMA0SAD: 0x040000b0,
  DMA0DAD: 0x040000b4,
  DMA0CNT_L: 0x040000b8,
  DMA0CNT_H: 0x040000ba,
  DMA1SAD: 0x040000bc,
  DMA1DAD: 0x040000c0,
  DMA1CNT_L: 0x040000c4,
  DMA1CNT_H: 0x040000c6,
  DMA2SAD: 0x040000c8,
  DMA2DAD: 0x040000cc,
  DMA2CNT_L: 0x040000d0,
  DMA2CNT_H: 0x040000d2,
  DMA3SAD: 0x040000d4,
  DMA3DAD: 0x040000d8,
  DMA3CNT_L: 0x040000dc,
  DMA3CNT_H: 0x040000de,

  // Timers
  TM0CNT_L: 0x04000100,
  TM0CNT_H: 0x04000102,
  TM1CNT_L: 0x04000104,
  TM1CNT_H: 0x04000106,
  TM2CNT_L: 0x04000108,
  TM2CNT_H: 0x0400010a,
  TM3CNT_L: 0x0400010c,
  TM3CNT_H: 0x0400010e,

  // Input
  KEYINPUT: 0x04000130,
  KEYCNT: 0x04000132,

  // Interrupts
  IE: 0x04000200,
  IF: 0x04000202,
  WAITCNT: 0x04000204,
  IME: 0x04000208,

  // GBA-internal
  POSTFLG: 0x04000300,
  HALTCNT: 0x04000301,
} as const;
