/** Where the arrow keys move inside a menu, and where an open menu sits, without a DOM to move them in. */
import { describe, expect, it } from 'vitest';

import { menuFocus, menuPlacement } from '../components.js';

describe('menu focus', () => {
  it('wraps at both ends', () => {
    expect(menuFocus('ArrowDown', 2, 3)).toBe(0);
    expect(menuFocus('ArrowDown', 0, 3)).toBe(1);
    expect(menuFocus('ArrowUp', 0, 3)).toBe(2);
    expect(menuFocus('ArrowUp', 2, 3)).toBe(1);
  });

  it('jumps to the ends', () => {
    expect(menuFocus('Home', 2, 3)).toBe(0);
    expect(menuFocus('End', 0, 3)).toBe(2);
  });

  it('leaves every other key alone', () => {
    for (const key of ['Enter', ' ', 'Escape', 'Tab', 'a', 'ArrowLeft']) {
      expect(menuFocus(key, 1, 3), key).toBe(-1);
    }
  });

  it('has nowhere to go in an empty menu', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(menuFocus(key, -1, 0), key).toBe(-1);
    }
  });
});

describe('menu placement', () => {
  const viewport = { width: 800, height: 600 };
  const list = { width: 190, height: 80 };
  /** a 22-pixel trigger whose top-left corner is at (`x`, `y`) */
  const trigger = (x: number, y: number) => ({ top: y, right: x + 22, bottom: y + 22, left: x });

  it('opens under its trigger, right edges aligned', () => {
    expect(menuPlacement(trigger(400, 100), list, viewport)).toEqual({ top: 124, left: 232 });
  });

  it('opens over its trigger when the room below is too short', () => {
    // the capture node's menu at the bottom of the graph pane, the case that ran off screen
    expect(menuPlacement(trigger(400, 560), list, viewport)).toEqual({ top: 478, left: 232 });
  });

  it('stays inside the viewport when neither side has the room', () => {
    const tall = { width: 190, height: 590 };
    expect(menuPlacement(trigger(400, 300), tall, viewport).top).toBe(6);
    expect(menuPlacement(trigger(400, 300), { width: 190, height: 700 }, viewport).top).toBe(4);
  });

  it('keeps its left edge on screen under a trigger near the left edge', () => {
    expect(menuPlacement(trigger(10, 100), list, viewport).left).toBe(4);
    expect(menuPlacement(trigger(790, 100), list, viewport).left).toBe(800 - 4 - 190);
  });
});
