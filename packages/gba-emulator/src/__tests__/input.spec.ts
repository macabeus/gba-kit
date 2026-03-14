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
  it('pressed buttons are cleared after deserialize', () => {
    const { input } = createInput();

    // Press the right arrow
    input.press(GbaButton.Right);
    expect(input.readKeyInput() & (1 << GbaButton.Right)).toBe(0); // active-low: 0 = pressed

    // Serialize while button is held
    const snapshot = input.serialize();
    expect(snapshot.buttons & (1 << GbaButton.Right)).not.toBe(0); // internal: bit set = pressed

    // Deserialize (simulates loading a save state)
    input.deserialize(snapshot);

    // After loading state, buttons must be released — the physical key is not held anymore
    expect(input.readKeyInput()).toBe(0x3ff); // all bits 1 = all released
  });

  it('multiple pressed buttons are all cleared after deserialize', () => {
    const { input } = createInput();

    input.press(GbaButton.A);
    input.press(GbaButton.Up);
    input.press(GbaButton.Start);

    const snapshot = input.serialize();

    input.deserialize(snapshot);

    // All buttons should be released
    expect(input.readKeyInput()).toBe(0x3ff);
  });

  it('keycnt is preserved after deserialize', () => {
    const { input } = createInput();

    input.writeKeyCnt(0xc00a);
    input.press(GbaButton.Left);

    const snapshot = input.serialize();

    input.deserialize(snapshot);

    // keycnt should be preserved (it's a configuration register, not transient input)
    expect(input.readKeyCnt()).toBe(0xc00a);
    // but buttons should be cleared
    expect(input.readKeyInput()).toBe(0x3ff);
  });
});
