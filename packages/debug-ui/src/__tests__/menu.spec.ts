/** Where the arrow keys move inside a menu, without a DOM to move them in. */
import { describe, expect, it } from 'vitest';

import { menuFocus } from '../components.js';

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
