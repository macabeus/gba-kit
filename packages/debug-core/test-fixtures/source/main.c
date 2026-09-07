#include "util.h"

#define REG_DISPCNT (*(volatile u16 *)0x04000000)
#define REG_DISPSTAT (*(volatile u16 *)0x04000004)
#define REG_KEYINPUT (*(volatile u16 *)0x04000130)
#define REG_IE (*(volatile u16 *)0x04000200)
#define REG_IF (*(volatile u16 *)0x04000202)
#define REG_IME (*(volatile u16 *)0x04000208)
#define BIOS_IF (*(volatile u16 *)0x03007ff8)
#define IRQ_HANDLER (*(void (*volatile *)(void))0x03007ffc)
#define VRAM ((volatile u16 *)0x06000000)

volatile u32 g_frame;
volatile u16 g_keys;
volatile u32 g_vblank_count;
struct Player g_player;
int g_samples[4] = {3, 5, 8, 13};
static int s_file_static;
extern volatile u16 g_linker_placed;

/* The VBlank handler the BIOS stub calls through 0x03007ffc. The stub enters it
 * with `ldr pc`, which on ARMv4 does not switch to Thumb, so it must be ARM code. */
__attribute__((target("arm"))) void isr(void) {
  g_vblank_count++;
  REG_IF = 1;
  BIOS_IF |= 1;
}

static inline void tick(void) {
  g_frame++;
}

static void wait_vblank(void) {
#ifdef __thumb__
  __asm__ volatile("swi 0x05" ::: "r0", "r1", "r2", "r3", "memory");
#else
  __asm__ volatile("swi 0x050000" ::: "r0", "r1", "r2", "r3", "memory");
#endif
}

void update(void) {
  int bonus = 2;
  int total = add_bonus((int)g_frame, bonus);
  move_player(&g_player, total & 1);
  {
    int shadow = -3;
    s_file_static += shadow;
  }
  g_samples[g_frame & 3] = total;
}

void draw(void) {
  VRAM[g_frame & 0x7fff] = 0x7fff; /* no division: keep libgcc out of the link */
}

int main(void) {
  REG_DISPCNT = 0x0403; /* mode 3, BG2 on */
  IRQ_HANDLER = isr;
  REG_DISPSTAT = 0x0008; /* VBlank IRQ */
  REG_IE = 1;
  REG_IME = 1;
  g_player.pos.x = 12;
  g_player.pos.y = -7;
  g_player.mode = MODE_PLAY;
  g_player.stats.hp = 9;
  g_player.stats.mp = 3;
  g_player.stats.flags = 0xa5;
  g_player.name[0] = 'K';
  g_player.name[1] = 'i';
  g_player.name[2] = 't';
  g_player.counterRef = &g_vblank_count;
  g_linker_placed = 7;
  for (;;) {
    wait_vblank();
    tick();
    g_keys = ~REG_KEYINPUT & 0x3ff;
    update();
    draw();
  }
  return 0;
}
