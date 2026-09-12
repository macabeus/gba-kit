/** A frame's register array: the values a layer established, and nothing where it established none. */
export function registerSlots(values: Record<number, number | undefined>): Array<number | undefined> {
  const regs: Array<number | undefined> = new Array<number | undefined>(16).fill(undefined);
  for (const [index, value] of Object.entries(values)) {
    regs[Number(index)] = value;
  }
  return regs;
}
