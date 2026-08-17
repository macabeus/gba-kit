/**
 * Headless GBA Runtime for Node.js
 *
 * Creates a Gba instance, loads ROM, and evaluates user scripts
 * via the ScriptingEngine.
 */
import { Gba, ScriptingEngine, type ScriptingHost } from '@gba-kit/gba-emulator';
import fs from 'fs/promises';
import vm from 'vm';

import { NodeScriptingHost } from './node-scripting-host.js';
import { deserializeSnapshot, serializeSnapshot } from './snapshot-serializer.js';

export interface HeadlessRuntimeOptions {
  romPath: string;
  loadSavePath?: string;
  outputDir: string;
  logFn: (message: string) => void;
  /**
   * Optional path to a (`-g`-built) sidecar ELF. Enables source-level scripting
   * (pcToSource, symbolToAddress, watchSymbol, and source-annotated watch hits).
   */
  elfPath?: string;
}

export class HeadlessRuntime {
  readonly #gba: Gba;
  readonly #engine: ScriptingEngine;
  readonly #host: ScriptingHost;
  readonly #outputDir: string;

  constructor(gba: Gba, host: ScriptingHost, outputDir: string) {
    this.#gba = gba;
    this.#host = host;
    this.#outputDir = outputDir;
    this.#engine = new ScriptingEngine(gba, host);

    // Wire CPU access for scripting engine
    const cpu = gba.armCpu;
    this.#engine.cpuRegisters = cpu.registers;
    this.#engine.cpuCpsr = () => cpu.cpsr;
    this.#engine.cpuSerialize = () => cpu.serialize();
    this.#engine.cpuDeserialize = (snap) => cpu.deserialize(snap);
  }

  get engine(): ScriptingEngine {
    return this.#engine;
  }

  get gba(): Gba {
    return this.#gba;
  }

  get host(): ScriptingHost {
    return this.#host;
  }

  static async create(options: HeadlessRuntimeOptions): Promise<HeadlessRuntime> {
    const host = new NodeScriptingHost(options.outputDir, options.logFn);

    const gba = new Gba();

    // Load ROM
    const romData = await fs.readFile(options.romPath);
    gba.loadRom(new Uint8Array(romData));

    // Set up initial CPU state (post-BIOS boot)
    const cpu = gba.armCpu;

    cpu.switchMode(0x12); // IRQ mode
    cpu.registers[13] = 0x03007fa0;

    cpu.switchMode(0x13); // SVC mode
    cpu.registers[13] = 0x03007fe0;

    cpu.switchMode(0x1f); // System mode
    cpu.registers[13] = 0x03007f00;

    cpu.cpsr = 0x1f; // SYS mode, IRQs enabled, ARM state
    cpu.registers[15] = 0x08000000; // ROM entry point

    // Load save state if provided
    if (options.loadSavePath) {
      const saveData = await fs.readFile(options.loadSavePath, 'utf-8');
      const snapshot = deserializeSnapshot(JSON.parse(saveData));
      gba.deserialize(snapshot);
    }

    const runtime = new HeadlessRuntime(gba, host, options.outputDir);

    // Load debug info (ELF symbols + DWARF) if provided.
    if (options.elfPath) {
      const elfData = await fs.readFile(options.elfPath);
      runtime.engine.loadDebugInfo(new Uint8Array(elfData));
    }

    return runtime;
  }

  /** Execute a script string against the emulator */
  async executeScript(scriptCode: string, scriptPath?: string): Promise<void> {
    const engine = this.#engine;

    // Build the script context with all API functions bound
    const context = vm.createContext({
      // Timing
      wait: (condition: Parameters<ScriptingEngine['wait']>[0]) => engine.wait(condition),

      // Input
      press: (buttons: Parameters<ScriptingEngine['press']>[0], options?: Parameters<ScriptingEngine['press']>[1]) =>
        engine.press(buttons, options),
      release: (button: Parameters<ScriptingEngine['release']>[0]) => engine.release(button),
      pressSequence: (inputs: Parameters<ScriptingEngine['pressSequence']>[0]) => engine.pressSequence(inputs),

      // Screenshots / memory
      takeScreenshot: (options: Parameters<ScriptingEngine['takeScreenshot']>[0]) => engine.takeScreenshot(options),
      takeMemorySnapshot: (options: Parameters<ScriptingEngine['takeMemorySnapshot']>[0]) =>
        engine.takeMemorySnapshot(options),
      getRegisters: () => engine.getRegisters(),
      getMemory: (address: number, length: number) => engine.getMemory(address, length),
      read16: (address: number) => engine.read16(address),
      read32: (address: number) => engine.read32(address),
      readBytes: (address: number, size: number) => engine.readBytes(address, size),
      readVariable: (path: string) => engine.readVariable(path),
      writeVariable: (path: string, value: number) => engine.writeVariable(path, value),
      readMember: (base: number, member: Parameters<ScriptingEngine['readMember']>[1]) =>
        engine.readMember(base, member),
      writeMember: (base: number, member: Parameters<ScriptingEngine['writeMember']>[1], value: number) =>
        engine.writeMember(base, member, value),
      disassemble: (address: number, count?: number, mode?: 'thumb' | 'arm') =>
        engine.disassemble(address, count, mode),
      disassembleFunction: (address: number, mode?: 'thumb' | 'arm') => engine.disassembleFunction(address, mode),
      readString: (address: number, maxLen?: number) => engine.readString(address, maxLen),
      getPixel: (x: number, y: number) => engine.getPixel(x, y),
      getScreenRegion: (x: number, y: number, width: number, height: number) =>
        engine.getScreenRegion(x, y, width, height),
      record: (options: Parameters<ScriptingEngine['record']>[0]) => engine.record(options),
      readOAM: () => engine.readOAM(),
      readBgScroll: (layer: number) => engine.readBgScroll(layer),
      readBgTilemap: (layer: number) => engine.readBgTilemap(layer),
      readDisplayControl: () => engine.readDisplayControl(),
      hashRegion: (x: number, y: number, w: number, h: number) => engine.hashRegion(x, y, w, h),
      onFrame: (cb: ((frame: number) => void) | null) => engine.onFrame(cb),
      searchMemory: (options: Parameters<ScriptingEngine['searchMemory']>[0]) => engine.searchMemory(options),
      filterMemory: (addresses: number[], options: Parameters<ScriptingEngine['filterMemory']>[1]) =>
        engine.filterMemory(addresses, options),
      watchMemory: (options: Parameters<ScriptingEngine['watchMemory']>[0]) => engine.watchMemory(options),
      watchSymbol: (name: string, options?: Parameters<ScriptingEngine['watchSymbol']>[1]) =>
        engine.watchSymbol(name, options),
      clearWatchpoints: () => engine.clearWatchpoints(),

      // Debug info (ELF symbols + DWARF) — available when created with `elfPath`.
      hasDebugInfo: () => engine.hasDebugInfo,
      pcToSource: (pc: number) => engine.pcToSource(pc),
      pcToFunction: (pc: number) => engine.pcToFunction(pc),
      addressToSymbol: (addr: number) => engine.addressToSymbol(addr),
      symbolToAddress: (name: string) => engine.symbolToAddress(name),

      // Save states
      saveState: (options: Parameters<ScriptingEngine['saveState']>[0]) => engine.saveState(options),
      loadState: (path: string) => engine.loadState(path),

      // Assertions
      assert: (condition: Parameters<ScriptingEngine['assert']>[0]) => engine.assert(condition),

      // Console
      console: {
        log: (...args: unknown[]) => this.#host.log(args.map(String).join(' ')),
      },
    });

    // Wrap in an async IIFE so top-level await works
    const wrappedCode = `(async () => {\n${scriptCode}\n})()`;

    const script = new vm.Script(wrappedCode, {
      filename: scriptPath ?? '<inline>',
    });

    await script.runInContext(context);
  }

  /** Write the final save state */
  async writeFinalSaveState(): Promise<void> {
    const snapshot = this.#gba.serialize();

    const serialized = serializeSnapshot(snapshot);
    const { default: fs } = await import('fs/promises');
    const { default: path } = await import('path');

    const filePath = path.join(this.#outputDir, 'final_save.json');
    await fs.writeFile(filePath, JSON.stringify(serialized, null, 2));
  }
}
