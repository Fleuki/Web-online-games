import type { GameAction, GameModule, GamePlayer } from "../types";

/**
 * TreeGame — заглушка первой игры.
 *
 * Каждый игрок рубит своё дерево: общего мира нет, столкновений нет,
 * синхронизировать надо одно число на игрока. Здесь пока только счётчик —
 * настоящая механика приедет позже, контракт от этого не изменится.
 */
export interface TreeGameState {
  /** playerId -> сколько раз срубил */
  scores: Record<string, number>;
}

/** Счёт, на котором партия заканчивается. */
export const TARGET_SCORE = 20;

export const treegame: GameModule<TreeGameState> = {
  meta: {
    id: "treegame",
    name: "Дерево",
    minPlayers: 2,
    maxPlayers: 2,
    icon: "🌲",
  },

  createState(players: GamePlayer[]): TreeGameState {
    const scores: Record<string, number> = {};
    for (const player of players) {
      scores[player.id] = 0;
    }
    return { scores };
  },

  validateAction(state, playerId, action: GameAction): boolean {
    if (action?.type !== "chop") return false;
    // Игрок должен участвовать в этой партии.
    if (!Object.prototype.hasOwnProperty.call(state.scores, playerId)) return false;
    // После победы рубить уже нечего.
    if (treegame.checkGameOver(state) !== null) return false;
    return true;
  },

  applyAction(state, playerId): TreeGameState {
    return {
      ...state,
      scores: { ...state.scores, [playerId]: state.scores[playerId] + 1 },
    };
  },

  checkGameOver(state) {
    for (const [playerId, score] of Object.entries(state.scores)) {
      if (score >= TARGET_SCORE) {
        return { winnerId: playerId, reason: "target" };
      }
    }
    return null;
  },
};

export default treegame;
