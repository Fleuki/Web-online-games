/**
 * mulberry32 — маленький детерминированный генератор.
 *
 * Math.random() тут не годится: ствол должен получаться одинаковым у обоих
 * игроков и повторяться в тестах, а для этого нужен сид.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
