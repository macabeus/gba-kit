/**
 * Execution watchpoints — the CPU-side primitive behind `watchExecution` and
 * `wait({ pc })`.
 *
 * They exist because sampling the PC between frames is not an observation of
 * execution: it sees only whatever the CPU is doing at the sample instant, so code
 * that runs constantly in between reads as never reached. These pin that the
 * watchpoint counts every pass, composes with `setDebugHooks` rather than replacing
 * it, and stops when disposed.
 */
import { describe, expect, it } from 'vitest';

import { ArmCpu } from '../arm-cpu.js';
import { GbaMemory } from '../memory.js';
import { PC } from '../types.js';

const BASE = 0x02000000;

/** A CPU in Thumb state running `nop; nop; b -4` — a three-instruction loop at BASE. */
function loopingCpu(): ArmCpu {
  const mem = new GbaMemory();
  // 0x46c0 = nop (mov r8, r8). 0xe7fc = `b` with offset11 = -4: the branch sits at
  // BASE+4 and lands on BASE+8 + (-4 * 2) = BASE, so the three instructions loop.
  const code = [0x46c0, 0x46c0, 0xe7fc];
  const bytes = new Uint8Array(code.length * 2);
  code.forEach((instr, i) => {
    bytes[i * 2] = instr & 0xff;
    bytes[i * 2 + 1] = (instr >>> 8) & 0xff;
  });
  mem.loadBytes(BASE, bytes);
  const cpu = new ArmCpu(mem);
  cpu.registers[PC] = BASE;
  cpu.setT(true);
  return cpu;
}

describe('ArmCpu execution watchpoints', () => {
  it('fires once per execution of the watched instruction', () => {
    const cpu = loopingCpu();
    let hits = 0;
    cpu.addExecWatchpoint(BASE, () => hits++);
    for (let i = 0; i < 30; i++) {
      cpu.step();
    }
    // 30 steps over a 3-instruction loop passes BASE ten times.
    expect(hits).toBe(10);
  });

  it('does not fire for an address that never executes', () => {
    const cpu = loopingCpu();
    let hits = 0;
    cpu.addExecWatchpoint(BASE + 0x100, () => hits++);
    for (let i = 0; i < 30; i++) {
      cpu.step();
    }
    // A zero here has to mean "did not run", so the positive control above is what
    // makes this assertion worth anything.
    expect(hits).toBe(0);
  });

  it('stops firing once disposed', () => {
    const cpu = loopingCpu();
    let hits = 0;
    const dispose = cpu.addExecWatchpoint(BASE, () => hits++);
    for (let i = 0; i < 15; i++) {
      cpu.step();
    }
    const atDispose = hits;
    expect(atDispose).toBeGreaterThan(0);
    dispose();
    for (let i = 0; i < 15; i++) {
      cpu.step();
    }
    expect(hits).toBe(atDispose);
  });

  it('supports several watchpoints on one address, disposed independently', () => {
    const cpu = loopingCpu();
    let a = 0;
    let b = 0;
    const disposeA = cpu.addExecWatchpoint(BASE, () => a++);
    cpu.addExecWatchpoint(BASE, () => b++);
    for (let i = 0; i < 15; i++) {
      cpu.step();
    }
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    disposeA();
    const frozen = a;
    for (let i = 0; i < 15; i++) {
      cpu.step();
    }
    expect(a).toBe(frozen);
    expect(b).toBeGreaterThan(frozen);
  });

  it('tolerates a watchpoint disposing itself while firing', () => {
    // A one-shot wait is exactly this shape, so the dispatch must not skip or
    // double-fire the remaining callbacks.
    const cpu = loopingCpu();
    let once = 0;
    let other = 0;
    const dispose = cpu.addExecWatchpoint(BASE, () => {
      once++;
      dispose();
    });
    cpu.addExecWatchpoint(BASE, () => other++);
    for (let i = 0; i < 30; i++) {
      cpu.step();
    }
    expect(once).toBe(1);
    expect(other).toBe(10);
  });

  it('composes with setDebugHooks instead of replacing them', () => {
    // A single-slot hooks object is owned by whoever set it last; an analysis tool
    // must be able to watch a PC without evicting a debugger's hooks.
    const cpu = loopingCpu();
    let watch = 0;
    let hook = 0;
    cpu.addExecWatchpoint(BASE, () => watch++);
    cpu.setDebugHooks({
      onInstructionPre: () => {
        hook++;
        return 'continue';
      },
    });
    for (let i = 0; i < 30; i++) {
      cpu.step();
    }
    expect(watch).toBe(10);
    expect(hook).toBe(30);
  });
});
