// Klonoa: Empire of Dreams — the hidden boot minigame
//
// Holding A+B+RIGHT+L+R while the ROM boots makes AgbMain swap callback slot 1
// for MainGameFrameLoop, which drops you on the "Delete all save data?" screen
// with enemies raining down it. Adding UP to that combo also arms a player
// avatar: MainGameFrameLoop latches the D-pad state into gMinigamePlayerArmed,
// and Select then spawns Klonoa at (0x78, 0x9C) so L/R can dodge.
//
// AgbMain reads the key mirror once, masks it with 0x0313 (= A|B|RIGHT|R|L) and
// requires an exact match, so the combo only registers if it is already held on
// the very first frame.
//
// >> Load the ROM and replay this WITHOUT pressing Run first. <<
// Loading a ROM resets the emulator and leaves it paused at frame 0, which is
// exactly what the combo needs. Once the game has booted past AgbMain the
// window is gone and replaying this does nothing.

await pressSequence([
  // Boot with the combo held. UP is the part that arms the avatar; drop it and
  // the enemies still fall but Select does nothing.
  ['a+b+right+l+r+up', 200],

  // Let the menu settle.
  [null, 120],

  // Spawn Klonoa at the centre-bottom of the screen.
  ['select', 4],
  [null, 60],

  // Dodge: R slides him right, L slides him left, 2px per frame, clamped to
  // [0x10, 0xDF]. Touching a falling enemy plays hit animation 0x0C, which
  // locks the controls until it finishes.
  ['r', 45],
  [null, 20],
  ['l', 70],
  [null, 20],
  ['r', 50],
  [null, 90],
]);
