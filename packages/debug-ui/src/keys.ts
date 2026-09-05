/**
 * Buttons: the GBA's bit order, the keyboard layout the screen panel uses, and
 * the standard-gamepad mapping.
 */
export const BUTTONS = ['A', 'B', 'Select', 'Start', 'Right', 'Left', 'Up', 'Down', 'R', 'L'] as const;

export const enum Button {
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

/** `KeyboardEvent.key` (single letters lower-cased) → button. */
export const KEYBOARD: Readonly<Record<string, number>> = {
  z: Button.A,
  x: Button.B,
  Backspace: Button.Select,
  Enter: Button.Start,
  ArrowRight: Button.Right,
  ArrowLeft: Button.Left,
  ArrowUp: Button.Up,
  ArrowDown: Button.Down,
  a: Button.R,
  s: Button.L,
};

export const KEYBOARD_HINT = 'arrows = D-pad · Z = A · X = B · Enter = Start · Backspace = Select · A = R · S = L';

/** The button a keyboard event stands for, or -1. */
export function buttonForKey(key: string): number {
  const k = key.length === 1 ? key.toLowerCase() : key;
  return KEYBOARD[k] ?? -1;
}

/** W3C standard gamepad button index → GBA button. */
export const GAMEPAD: ReadonlyArray<[number, number]> = [
  [0, Button.A], // bottom face
  [1, Button.B], // right face
  [2, Button.B], // left face, also B: the common "two buttons" grip
  [3, Button.A],
  [4, Button.L],
  [5, Button.R],
  [6, Button.L],
  [7, Button.R],
  [8, Button.Select],
  [9, Button.Start],
  [12, Button.Up],
  [13, Button.Down],
  [14, Button.Left],
  [15, Button.Right],
];

/** The GBA button mask a standard gamepad's buttons and left stick express. */
export function gamepadMask(buttons: ReadonlyArray<{ pressed: boolean }>, axes: ReadonlyArray<number>): number {
  let mask = 0;
  for (const [index, button] of GAMEPAD) {
    if (buttons[index]?.pressed) {
      mask |= 1 << button;
    }
  }
  const x = axes[0] ?? 0;
  const y = axes[1] ?? 0;
  if (x > 0.5) {
    mask |= 1 << Button.Right;
  } else if (x < -0.5) {
    mask |= 1 << Button.Left;
  }
  if (y > 0.5) {
    mask |= 1 << Button.Down;
  } else if (y < -0.5) {
    mask |= 1 << Button.Up;
  }
  return mask;
}
