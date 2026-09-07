import { describe, expect, it } from 'vitest';

import { InputController } from '../input.js';
import { InterruptController } from '../interrupts.js';
import { GbaButton } from '../types.js';

function createInput() {
  const interrupts = new InterruptController();
  const input = new InputController(interrupts);
  return { input, interrupts };
}

describe('InputController', () => {
  it('held buttons are restored by deserialize, so a replay sees what the original run saw', () => {
    const { input } = createInput();

    input.press(GbaButton.Right);
    expect(input.readKeyInput() & (1 << GbaButton.Right)).toBe(0); // active-low: 0 = pressed

    const snapshot = input.serialize();
    expect(snapshot.buttons & (1 << GbaButton.Right)).not.toBe(0); // internal: bit set = pressed

    input.release(GbaButton.Right);
    input.deserialize(snapshot);

    expect(input.readKeyInput() & (1 << GbaButton.Right)).toBe(0);
  });

  it('a snapshot with several buttons held restores all of them and nothing else', () => {
    const { input } = createInput();

    input.press(GbaButton.A);
    input.press(GbaButton.Up);
    input.press(GbaButton.Start);
    const snapshot = input.serialize();

    input.reset();
    input.press(GbaButton.B);
    input.deserialize(snapshot);

    const held = ~input.readKeyInput() & 0x3ff;
    expect(held).toBe((1 << GbaButton.A) | (1 << GbaButton.Up) | (1 << GbaButton.Start));
  });

  it('keycnt is preserved after deserialize', () => {
    const { input } = createInput();

    input.writeKeyCnt(0xc00a);
    input.press(GbaButton.Left);

    const snapshot = input.serialize();
    input.reset();
    input.deserialize(snapshot);

    expect(input.readKeyCnt()).toBe(0xc00a);
    expect(input.readKeyInput() & (1 << GbaButton.Left)).toBe(0);
  });

  it('a player-facing load can release everything afterwards with setButtons(0)', () => {
    const { input } = createInput();
    input.press(GbaButton.A);
    const snapshot = input.serialize();
    input.deserialize(snapshot);
    input.setButtons(0);
    expect(input.readKeyInput()).toBe(0x3ff);
  });
});
