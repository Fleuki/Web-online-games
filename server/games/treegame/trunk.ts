import { treegameConfig } from "./config";
import { mulberry32 } from "./prng";

export type BranchSide = "left" | "right";

export interface TrunkSegment {
  /** Абсолютный номер сегмента от начала ствола. */
  index: number;
  branch: BranchSide | null;
}

const { safeStart, maxSameRun, branchChance, chunkSize } = treegameConfig;

/**
 * Сколько веток подряд с этой стороны заканчивается на конце участка.
 * Пустой сегмент или ветка с другой стороны обрывают серию.
 */
function trailingRun(segments: TrunkSegment[], side: BranchSide): number {
  let run = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].branch !== side) break;
    run++;
  }
  return run;
}

/**
 * Ствол от нулевого сегмента.
 *
 * Считается целиком от начала — так участок, догенерированный позже,
 * получается ровно тем же, что и при генерации всего ствола сразу.
 * Стоит это пары сотен вызовов генератора за партию, зато детерминированность
 * не зависит от того, когда именно понадобилось продолжение.
 */
export function buildTrunk(seed: number, count: number): TrunkSegment[] {
  const random = mulberry32(seed);
  const segments: TrunkSegment[] = [];

  for (let index = 0; index < count; index++) {
    segments.push({ index, branch: nextBranch(random, segments, index) });
  }

  return segments;
}

function nextBranch(
  random: () => number,
  segments: TrunkSegment[],
  index: number
): BranchSide | null {
  // Первые сегменты — всегда чистые.
  if (index < safeStart) return null;

  // Генератор дёргаем всегда, даже когда ветка не выпала: иначе на длину
  // серии влиял бы порядок ветвлений, и участок стало бы не воспроизвести.
  const roll = random();
  const sideRoll = random();

  if (roll >= branchChance) return null;

  const side: BranchSide = sideRoll < 0.5 ? "left" : "right";

  // Четвёртой ветке подряд с одной стороны взяться неоткуда.
  return trailingRun(segments, side) >= maxSameRun ? other(side) : side;
}

export function other(side: BranchSide): BranchSide {
  return side === "left" ? "right" : "left";
}

/** До скольких сегментов растить ствол, чтобы покрыть позицию с запасом. */
export function chunkedLength(neededIndex: number): number {
  const needed = neededIndex + 1;
  return Math.max(chunkSize, Math.ceil(needed / chunkSize) * chunkSize);
}
