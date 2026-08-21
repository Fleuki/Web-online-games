import { randomInt } from "node:crypto";
import type { GameAction, GameModule, GamePlayer, GameOver } from "../types";
import { treegameConfig } from "./config";
import { buildTrunk, chunkedLength, type BranchSide, type TrunkSegment } from "./trunk";

export type { BranchSide, TrunkSegment } from "./trunk";
export { treegameConfig } from "./config";

export interface TreeGamePlayer {
  score: number;
  /** Время сервера (мс), до которого игрок оглушён. 0 — управление есть. */
  stunnedUntil: number;
  /**
   * Оглушён ли игрок прямо сейчас.
   *
   * stunnedUntil — время сервера, и сравнивать его с часами на телефоне
   * нельзя. Поэтому момент «у соперника сейчас ошибка» вынесен в отдельное
   * поле: соперник читает его как есть, ничего не пересчитывая.
   */
  stunned: boolean;
}

export interface TreeGameState {
  seed: number;
  targetScore: number;
  stunDurationMs: number;
  /**
   * Окно ствола: от сегмента самого отстающего игрока и вверх с запасом.
   * У каждого сегмента есть абсолютный index, поэтому срубленное низовье
   * можно выбрасывать, не сбивая нумерацию.
   */
  trunk: TrunkSegment[];
  players: Record<string, TreeGamePlayer>;
}

export interface ChopAction extends GameAction {
  type: "chop";
  side: BranchSide;
}

const { targetScore, stunDurationMs, lookahead } = treegameConfig;

function isSide(value: unknown): value is BranchSide {
  return value === "left" || value === "right";
}

/** Сегмент, на котором игрок стоит сейчас. */
function segmentAt(state: TreeGameState, index: number): TrunkSegment | undefined {
  if (state.trunk.length === 0) return undefined;
  return state.trunk[index - state.trunk[0].index];
}

/**
 * Пересчитывает публичные флаги оглушения по серверным часам.
 *
 * Вызывается на каждом изменении состояния: партия синхронная, удары
 * сыплются часто, и флаг соперника успевает погаснуть почти вовремя.
 * Точное время окончания клиент всё равно доигрывает у себя по
 * stunDurationMs — а истина о том, оглушён ли игрок, остаётся здесь.
 */
function refreshStunFlags(state: TreeGameState, at: number): TreeGameState {
  let changed = false;
  const players: Record<string, TreeGamePlayer> = {};

  for (const [id, player] of Object.entries(state.players)) {
    const stunned = at < player.stunnedUntil;
    if (stunned === player.stunned) {
      players[id] = player;
      continue;
    }
    players[id] = { ...player, stunned };
    changed = true;
  }

  return changed ? { ...state, players } : state;
}

function scoresOf(state: TreeGameState): number[] {
  const scores = Object.values(state.players).map((player) => player.score);
  return scores.length > 0 ? scores : [0];
}

/**
 * Догенерирует ствол, когда игрок подобрался к концу участка, и выбрасывает
 * то, что уже срублено всеми.
 *
 * Второе — не украшательство: состояние партии уезжает клиенту целиком на
 * каждый удар, и без обрезки в него попадал бы весь пройденный ствол.
 */
function reframeTrunk(state: TreeGameState): TreeGameState {
  const scores = scoresOf(state);
  const highest = Math.max(...scores);
  const lowest = Math.min(...scores);

  const generated = state.trunk.length > 0
    ? state.trunk[state.trunk.length - 1].index + 1
    : 0;

  const needed = chunkedLength(highest + lookahead);
  const trunk = needed > generated
    ? buildTrunk(state.seed, needed)
    : state.trunk;

  // Ниже самого отстающего игрока ствола уже нет — он его срубил.
  const from = trunk[0].index;
  const window = lowest > from ? trunk.slice(lowest - from) : trunk;

  return window === state.trunk ? state : { ...state, trunk: window };
}

export const treegame: GameModule<TreeGameState> = {
  meta: {
    id: "treegame",
    name: "Дерево",
    minPlayers: 2,
    maxPlayers: 2,
    icon: "🌲",
  },

  createState(players: GamePlayer[]): TreeGameState {
    const state: TreeGameState = {
      // Сид рождается на сервере и уезжает в состояние: ствол у обоих
      // игроков обязан совпадать до сегмента.
      seed: randomInt(0, 2 ** 31),
      targetScore,
      stunDurationMs,
      trunk: [],
      players: {},
    };

    for (const player of players) {
      state.players[player.id] = { score: 0, stunnedUntil: 0, stunned: false };
    }

    return reframeTrunk(state);
  },

  validateAction(state, playerId, action: GameAction): boolean {
    if (action?.type !== "chop") return false;
    if (!isSide((action as ChopAction).side)) return false;

    const player = state.players[playerId];
    if (!player) return false;

    // Оглушённый теряет управление — удары не проходят.
    if (Date.now() < player.stunnedUntil) return false;

    // Партия уже сыграна.
    if (treegame.checkGameOver(state) !== null) return false;

    return true;
  },

  applyAction(state, playerId, action: GameAction): TreeGameState {
    const { side } = action as ChopAction;
    const now = Date.now();

    // Чужие оглушения могли истечь с прошлого удара — гасим их тем же
    // проходом, чтобы флаг не висел до следующего действия его хозяина.
    const fresh = refreshStunFlags(state, now);
    const player = fresh.players[playerId];
    const segment = segmentAt(fresh, player.score);

    // Удар пришёлся в ветку: счёт не растёт, управление отнимается.
    if (segment?.branch === side) {
      return {
        ...fresh,
        players: {
          ...fresh.players,
          [playerId]: {
            score: player.score,
            stunnedUntil: now + state.stunDurationMs,
            stunned: true,
          },
        },
      };
    }

    const next: TreeGameState = {
      ...fresh,
      players: {
        ...fresh.players,
        [playerId]: { score: player.score + 1, stunnedUntil: 0, stunned: false },
      },
    };

    return reframeTrunk(next);
  },

  checkGameOver(state): GameOver | null {
    for (const [playerId, player] of Object.entries(state.players)) {
      if (player.score >= state.targetScore) {
        return { winnerId: playerId, reason: "target" };
      }
    }
    return null;
  },
};

export default treegame;
