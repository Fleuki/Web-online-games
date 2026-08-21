import { MapSchema, Schema, type } from "@colyseus/schema";

/**
 * Фазы комнаты.
 *
 * Комната переживает партию: цикл LOBBY → IN_GAME → RESULTS → LOBBY
 * крутится сколько угодно раз, а игроки, ники, хост и счёт за сессию
 * живут поверх него и сбрасываются только вместе с комнатой.
 */
export const Phase = {
  /** Выбор игры и подтверждение готовности. */
  LOBBY: "lobby",
  /** Идёт партия. */
  IN_GAME: "in_game",
  /** Партия сыграна, показываем итог и ждём, что делать дальше. */
  RESULTS: "results",
} as const;

export type PhaseValue = (typeof Phase)[keyof typeof Phase];

export class Player extends Schema {
  @type("string") sessionId: string = "";
  @type("string") name: string = "";
  /** false — игрок отвалился и мы ждём его возвращения. */
  @type("boolean") connected: boolean = true;

  /**
   * Готов ли игрок к следующей партии.
   *
   * Партию запускает не хост в одиночку, а согласие обоих: тот, кто ещё
   * не отдышался после прошлой, не должен оказаться в новой против воли.
   */
  @type("boolean") ready: boolean = false;

  /** Побед за сессию комнаты. Обнуляется только вместе с комнатой. */
  @type("number") wins: number = 0;
}

export class RoomState extends Schema {
  @type("string") phase: PhaseValue = Phase.LOBBY;

  /** Выбранная игра. В лобби её меняет хост. */
  @type("string") gameId: string = "";
  @type("string") gameName: string = "";

  /** sessionId хоста — только он выбирает игру. */
  @type("string") hostId: string = "";
  @type({ map: Player }) players = new MapSchema<Player>();

  /**
   * Сколько секунд ждём отвалившегося игрока.
   *
   * Клиент отсчитывает их у себя с момента, когда увидел connected: false —
   * так на таймер не влияет расхождение часов между устройствами.
   */
  @type("number") reconnectTimeout: number = 0;

  /**
   * Состояние партии, сериализованное в JSON.
   *
   * Ядро принципиально не знает его формы — это территория игрового модуля.
   * Плата за это — состояние летит целиком, без дельт; для «счёт: 7» цена
   * нулевая. Игра, которой это станет дорого, заведёт собственную Schema.
   */
  @type("string") gameState: string = "";

  /** Сколько партий в комнате уже начиналось. */
  @type("number") matchNumber: number = 0;

  /** Итог последней партии; заполняются в момент её окончания. */
  @type("string") winnerId: string = "";
  @type("string") gameOverReason: string = "";
}
