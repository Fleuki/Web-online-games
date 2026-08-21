import { Client, Room, ServerError } from "@colyseus/core";
import { config } from "./config";
import { getGame } from "./games/registry";
import type { GameAction, GameModule, GamePlayer } from "./games/types";
import { generateRoomCode } from "./roomCode";
import { Phase, Player, RoomState } from "./state";

const MAX_NAME_LENGTH = 16;

/**
 * Комнату заводит сервер по запросу из лобби, поэтому какое-то время она
 * стоит пустая. Если за это время не пришёл никто — ссылку не открыли,
 * и держать комнату незачем.
 */
const ABANDONED_ROOM_TIMEOUT_MS = 5 * 60 * 1000;

export interface JoinOptions {
  name?: string;
}

export interface CreateOptions extends JoinOptions {
  gameId?: string;
}

/** Обрезает и чистит ник. Пустой — заменяем, а не отвергаем. */
function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "Игрок";

  // Управляющие символы ломают вёрстку и логи — выкидываем их.
  const cleaned = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();

  return cleaned.slice(0, MAX_NAME_LENGTH) || "Игрок";
}

/**
 * Ядро комнаты.
 *
 * Про конкретные игры не знает ничего: берёт модуль из реестра и дёргает
 * createState / validateAction / applyAction / checkGameOver. Всё, что
 * приходит от клиента, — намерение; состояние меняется только здесь.
 */
export class GameRoom extends Room<RoomState> {
  private game!: GameModule<any>;
  /** Состояние партии в виде обычного объекта; в state уезжает как JSON. */
  private gameState: unknown = null;
  private abandonedTimer?: NodeJS.Timeout;

  async onCreate(options: CreateOptions = {}) {
    const gameId = options.gameId?.trim() || config.defaultGame;
    const game = getGame(gameId);

    if (!game) {
      throw new ServerError(4004, `Неизвестная игра: "${gameId}"`);
    }

    this.game = game;
    this.maxClients = game.meta.maxPlayers;

    // Свой короткий код вместо сгенерированного Colyseus id.
    // listing сохраняется после onCreate, так что подмена безопасна.
    this.roomId = await generateRoomCode();

    const state = new RoomState();
    state.gameId = game.meta.id;
    state.gameName = game.meta.name;
    state.reconnectTimeout = config.reconnectTimeout;
    this.setState(state);

    this.setMetadata({ gameId: game.meta.id, gameName: game.meta.name });

    this.onMessage("start", (client) => this.handleStart(client));
    this.onMessage("action", (client, action: GameAction) =>
      this.handleAction(client, action)
    );

    this.abandonedTimer = setTimeout(() => {
      if (this.clients.length === 0) {
        console.log(`[room ${this.roomId}] никто не пришёл, закрываю`);
        this.disconnect();
      }
    }, ABANDONED_ROOM_TIMEOUT_MS);

    console.log(`[room ${this.roomId}] создана, игра "${game.meta.id}"`);
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    // Пришёл первый — дальше комнатой распоряжается autoDispose.
    clearTimeout(this.abandonedTimer);
    this.abandonedTimer = undefined;

    const player = new Player();
    player.sessionId = client.sessionId;
    player.name = sanitizeName(options.name);
    player.connected = true;

    this.state.players.set(client.sessionId, player);

    // Хост — первый вошедший.
    if (!this.state.hostId) {
      this.state.hostId = client.sessionId;
    }

    console.log(`[room ${this.roomId}] вошёл ${player.name} (${client.sessionId})`);
  }

  /**
   * Игрок пропал. Сразу не удаляем: экран гаснет, сеть моргает, приложение
   * сворачивается — это норма, а не выход из игры.
   */
  async onLeave(client: Client, consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Осознанный выход и выход после конца партии ждать не нужно.
    if (consented || this.state.phase === Phase.FINISHED) {
      this.removePlayer(client.sessionId, consented);
      return;
    }

    player.connected = false;
    console.log(
      `[room ${this.roomId}] ${player.name} отвалился, ждём ${config.reconnectTimeout} c`
    );

    try {
      await this.allowReconnection(client, config.reconnectTimeout);
      player.connected = true;
      console.log(`[room ${this.roomId}] ${player.name} вернулся`);
    } catch {
      // Не вернулся за отведённое время.
      console.log(`[room ${this.roomId}] ${player.name} не вернулся`);
      this.removePlayer(client.sessionId, false);
    }
  }

  onDispose() {
    clearTimeout(this.abandonedTimer);
    console.log(`[room ${this.roomId}] закрыта`);
  }

  // --- игровой цикл -------------------------------------------------------

  private handleStart(client: Client) {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostId) return;

    const players = this.connectedPlayers();
    const { minPlayers, maxPlayers } = this.game.meta;
    if (players.length < minPlayers || players.length > maxPlayers) return;

    this.gameState = this.game.createState(players);
    this.syncGameState();
    this.state.phase = Phase.PLAYING;

    // Пока идёт партия, по коду больше никто не зайдёт.
    this.lock();

    console.log(`[room ${this.roomId}] партия началась`);
  }

  private handleAction(client: Client, action: GameAction) {
    if (this.state.phase !== Phase.PLAYING) return;
    if (!action || typeof action.type !== "string") return;

    const playerId = client.sessionId;

    // Клиенту не верим на слово: то, что не прошло validateAction,
    // до состояния не доходит.
    if (!this.game.validateAction(this.gameState, playerId, action)) return;

    this.gameState = this.game.applyAction(this.gameState, playerId, action);
    this.syncGameState();

    const result = this.game.checkGameOver(this.gameState);
    if (result) {
      this.finish(result.winnerId, result.reason);
    }
  }

  private finish(winnerId: string | null, reason: string) {
    if (this.state.phase === Phase.FINISHED) return;

    this.state.phase = Phase.FINISHED;
    this.state.winnerId = winnerId ?? "";
    this.state.gameOverReason = reason;
    this.lock();

    console.log(
      `[room ${this.roomId}] партия окончена: ${reason}, победитель "${winnerId ?? "нет"}"`
    );
  }

  // --- вспомогательное ----------------------------------------------------

  private syncGameState() {
    this.state.gameState = JSON.stringify(this.gameState ?? null);
  }

  private connectedPlayers(): GamePlayer[] {
    const players: GamePlayer[] = [];
    this.state.players.forEach((player, sessionId) => {
      if (player.connected) players.push({ id: sessionId, name: player.name });
    });
    return players;
  }

  /**
   * Убирает игрока насовсем. Во время партии это поражение:
   * победа достаётся тому, кто остался.
   */
  private removePlayer(sessionId: string, consented: boolean) {
    const wasPlaying = this.state.phase === Phase.PLAYING;

    this.state.players.delete(sessionId);

    if (wasPlaying) {
      const remaining = [...this.state.players.keys()];
      this.finish(
        remaining.length === 1 ? remaining[0] : null,
        consented ? "resign" : "forfeit"
      );
    }

    // Хост ушёл до начала партии — передаём права следующему.
    if (this.state.hostId === sessionId) {
      this.state.hostId = this.state.players.keys().next().value ?? "";
    }
  }
}
