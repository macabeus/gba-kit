typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

typedef struct {
  int x;
  int y;
} Point;

enum Mode { MODE_IDLE = 0, MODE_PLAY = 1, MODE_DONE = 2 };

typedef struct {
  u16 hp : 4;
  u16 mp : 4;
  u16 flags : 8;
} Stats;

struct Player {
  Point pos;
  enum Mode mode;
  Stats stats;
  u8 name[8];
  volatile u32 *counterRef;
};

int add_bonus(int value, int bonus);
void move_player(struct Player *p, int dx);
