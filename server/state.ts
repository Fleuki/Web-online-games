import { MapSchema, Schema, type } from "@colyseus/schema";

/** Фазы комнаты. */
export const Phase = {
  LOBBY: "lobby",
  PLAYING: "playing",
  FINISHED: "finished",
} as const;

export type PhaseValue = (typeof Phase)[keyof typeof Phase];

export class Player extends Schema {
  @type("string") sessionId: string = "";
  @type("string") name: string = "";
  /** false — игрок отвалился и мы ждём его возвращения. */
  @type("boolean") connected: boolean = true;
}

export class RoomState extends Schema {
  @type("string") phase: PhaseValue = Phase.LOBBY;
  @type("string") gameId: string = "";
  @type("string") gameName: string = "";
  /** sessionId хоста — только он может нажать «Начать». */
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

  /** Заполняются в момент конца партии. */
  @type("string") winnerId: string = "";
  @type("string") gameOverReason: string = "";
}
