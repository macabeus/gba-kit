#include "util.h"

/* Second translation unit: a callee with parameters and a local, and one that
 * writes through a pointer, so a data breakpoint can catch a write made here. */
int g_bonus_calls;

__attribute__((noinline)) int add_bonus(int value, int bonus) {
  int result = value + bonus;
  g_bonus_calls++;
  return result;
}

__attribute__((noinline)) void move_player(struct Player *p, int dx) {
  p->pos.x += dx;
  if (p->pos.x > 100) {
    p->mode = MODE_DONE;
  }
}
