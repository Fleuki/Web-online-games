/**
 * Контракт игрового модуля.
 *
 * Ядро (GameRoom) не знает ни про дерево, ни про шахматы — оно умеет только
 * вызывать эти пять вещей через реестр. Добавление игры = новая папка
 * + одна строка в registry.ts. Ноль правок в ядре.
 */

/** Игрок в том виде, в каком его видит игровой модуль. */
export interface GamePlayer {
  /** sessionId Colyseus — им же подписаны все действия. */
  id: string;
  name: string;
}

export interface GameMeta {
  /** Уникальный id модуля, он же имя папки. */
  id: string;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  /** Эмодзи или короткая строка для лобби. */
  icon: string;
}

/** Результат партии. winnerId === null — ничья. */
export interface GameOver {
  winnerId: string | null;
  /** Машиночитаемая причина: 'target', 'draw', 'forfeit', ... */
  reason: string;
}

/** Намерение игрока. Ядро его не разбирает — просто передаёт модулю. */
export interface GameAction {
  type: string;
  [key: string]: unknown;
}

export interface GameModule<TState = unknown> {
  meta: GameMeta;

  /** Начальное состояние партии. */
  createState(players: GamePlayer[]): TState;

  /**
   * Проверка намерения. Всё, что вернуло false, до applyAction не доходит.
   * Здесь и только здесь живёт защита от читера: клиенту доверять нельзя.
   */
  validateAction(state: TState, playerId: string, action: GameAction): boolean;

  /**
   * Применение намерения. Вызывается только после успешного validateAction.
   * Возвращает новое состояние (модуль волен вернуть и тот же объект,
   * но чистые функции удобнее тестировать).
   */
  applyAction(state: TState, playerId: string, action: GameAction): TState;

  /** null — партия продолжается. */
  checkGameOver(state: TState): GameOver | null;
}
