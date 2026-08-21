import { Client, Room, ServerError } from "@colyseus/core";
import { config } from "./config";
import { getGame } from "./games/registry";
import type { GameAction, GameModule, GamePlayer } from "./games/types";
import { generateRoomCode } from "./roomCode";
import { Phase, Player, RoomState } from "./state";

const MAX_NAME_LENGTH = 16;

/**
 * Комната живёт, пока в ней кто-то есть. Пустая — ещё пять минут: столько
 * же ждёт только что созданная комната, за которой не пришли по ссылке,
 * и столько же есть у двоих, чтобы вернуться после общего обрыва связи.
 */
const EMPTY_ROOM_TIMEOUT_MS = 5 * 60 * 1000;

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
 * Разделено на два уровня. Комната — постоянный контейнер: игроки, ники,
 * хост, счёт за сессию. Партия — временная сессия внутри неё: выбранный
 * модуль и его состояние. Конец партии комнату не разрушает, игроков
 * никуда не выкидывает и счёт не обнуляет.
 *
 * Про конкретные игры ядро не знает ничего: берёт модуль из реестра и дёргает
 * createState / validateAction / applyAction / checkGameOver. Всё, что
 * приходит от клиента, — намерение; состояние меняется только здесь.
 */
export class GameRoom extends Room<RoomState> {
  private game!: GameModule<any>;
  /** Состояние партии в виде обычного объекта; в state уезжает как JSON. */
  private gameState: unknown = null;
  private emptyTimer?: NodeJS.Timeout;

  async onCreate(options: CreateOptions = {}) {
    const gameId = options.gameId?.trim() || config.defaultGame;
    const game = getGame(gameId);

    if (!game) {
      throw new ServerError(4004, `Неизвестная игра: "${gameId}"`);
    }

    /*
     * Комнатой распоряжаемся сами. autoDispose закрыл бы её в момент, когда
     * последний клиент отвалился, — а комната к этому моменту хранит счёт
     * за сессию, и обоим ещё возвращаться.
     */
    this.autoDispose = false;

    await this.assignRoomCode();

    const state = new RoomState();
    state.reconnectTimeout = config.reconnectTimeout;
    this.setState(state);

    this.selectGame(game);

    this.onMessage("select-game", (client, message: { gameId?: unknown }) =>
      this.handleSelectGame(client, message)
    );
    this.onMessage("ready", (client, ready: unknown) =>
      this.handleReady(client, ready)
    );
    this.onMessage("to-lobby", (client) => this.handleToLobby(client));
    this.onMessage("action", (client, action: GameAction) =>
      this.handleAction(client, action)
    );

    this.scheduleClose();

    console.log(`[room ${this.roomId}] создана, игра "${game.meta.id}"`);
  }

  /**
   * Свой короткий код вместо сгенерированного Colyseus id.
   * listing сохраняется после onCreate, так что подмена безопасна.
   *
   * Отдельным методом — код выдаёт матчмейкер, а в тестах ядра его нет.
   */
  protected async assignRoomCode() {
    this.roomId = await generateRoomCode();
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    // Пока в комнате кто-то есть, закрывать её незачем.
    clearTimeout(this.emptyTimer);
    this.emptyTimer = undefined;

    const player = new Player();
    player.sessionId = client.sessionId;
    player.name = sanitizeName(options.name);
    player.connected = true;

    this.state.players.set(client.sessionId, player);

    // Хост — первый вошедший.
    if (!this.state.hostId) {
      this.state.hostId = client.sessionId;
    }

    /*
     * Место освобождается только когда кто-то ушёл, так что зайти на экран
     * результатов можно лишь на чужое место. Итог партии, которую новичок
     * не играл, ему ни о чём не говорит — уводим комнату к выбору игры.
     */
    if (this.state.phase === Phase.RESULTS) {
      this.toLobby();
    }

    console.log(`[room ${this.roomId}] вошёл ${player.name} (${client.sessionId})`);
  }

  /**
   * Игрок пропал. Сразу не удаляем: экран гаснет, сеть моргает, приложение
   * сворачивается — это норма, а не выход из игры. Ждём его в любой фазе,
   * не только внутри партии: в лобби и на экране результатов ему тоже есть
   * куда возвращаться.
   */
  async onLeave(client: Client, consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (consented) {
      this.removePlayer(client.sessionId, true);
      this.scheduleClose();
      return;
    }

    player.connected = false;
    this.scheduleClose();

    console.log(
      `[room ${this.roomId}] ${player.name} отвалился, ждём ${config.reconnectTimeout} c`
    );

    try {
      await this.allowReconnection(client, config.reconnectTimeout);
      player.connected = true;
      console.log(`[room ${this.roomId}] ${player.name} вернулся`);

      // Готовность он подтвердил до обрыва — она в силе.
      this.tryStartMatch();
    } catch {
      // Не вернулся за отведённое время.
      console.log(`[room ${this.roomId}] ${player.name} не вернулся`);
      this.removePlayer(client.sessionId, false);
    }
  }

  onDispose() {
    clearTimeout(this.emptyTimer);
    console.log(`[room ${this.roomId}] закрыта`);
  }

  // --- жизнь комнаты ------------------------------------------------------

  /**
   * Ставит игру комнаты и подгоняет под неё всё остальное.
   * Вызывается при создании и при смене игры хостом.
   */
  private selectGame(game: GameModule<any>) {
    this.game = game;
    this.maxClients = game.meta.maxPlayers;

    this.state.gameId = game.meta.id;
    this.state.gameName = game.meta.name;

    this.setMetadata({ gameId: game.meta.id, gameName: game.meta.name });
  }

  private handleSelectGame(client: Client, message: { gameId?: unknown }) {
    if (this.state.phase === Phase.IN_GAME) return;
    if (client.sessionId !== this.state.hostId) return;

    const gameId = typeof message?.gameId === "string" ? message.gameId.trim() : "";
    const game = getGame(gameId);
    if (!game || game.meta.id === this.state.gameId) return;

    // Игра, в которую уже собравшиеся не поместятся, комнате не подходит.
    if (this.state.players.size > game.meta.maxPlayers) return;

    this.selectGame(game);

    // Выбор поменялся — согласие на прошлую игру больше не в счёт.
    // И экран результатов прошлой партии тут же теряет смысл.
    this.toLobby();

    console.log(`[room ${this.roomId}] хост выбрал игру "${game.meta.id}"`);
  }

  /**
   * Готовность к следующей партии. Работает и в лобби, и на экране
   * результатов: «Играть снова» — та же кнопка, только другой подписью.
   */
  private handleReady(client: Client, ready: unknown) {
    if (this.state.phase === Phase.IN_GAME) return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    player.ready = ready === true;
    this.tryStartMatch();
  }

  /** «Другая игра»: возврат к выбору внутри комнаты, без выхода из неё. */
  private handleToLobby(client: Client) {
    if (this.state.phase !== Phase.RESULTS) return;
    if (!this.state.players.has(client.sessionId)) return;

    this.toLobby();
  }

  private toLobby() {
    this.state.phase = Phase.LOBBY;
    this.state.winnerId = "";
    this.state.gameOverReason = "";

    this.gameState = null;
    this.syncGameState();
    this.clearReady();
    this.unlock();
  }

  /**
   * Пустая комната закрывается не сразу: пять минут — это и «за ссылкой
   * никто не пришёл», и «у обоих одновременно моргнул интернет».
   */
  private scheduleClose() {
    clearTimeout(this.emptyTimer);
    this.emptyTimer = setTimeout(() => {
      if (this.clients.length > 0) return;
      console.log(`[room ${this.roomId}] пустая, закрываю`);
      this.disconnect();
    }, EMPTY_ROOM_TIMEOUT_MS);
  }

  // --- игровой цикл -------------------------------------------------------

  /**
   * Партия стартует сама, как только все на месте и все готовы.
   * Ни в лобби, ни с экрана результатов её не запускает кто-то один.
   */
  private tryStartMatch() {
    if (this.state.phase === Phase.IN_GAME) return;

    const players = this.connectedPlayers();
    const { minPlayers, maxPlayers } = this.game.meta;
    if (players.length < minPlayers || players.length > maxPlayers) return;

    // Отвалившийся не готов, даже если нажимал кнопку до обрыва:
    // начинать партию, пока он возвращается, нечестно.
    let allReady = true;
    this.state.players.forEach((player) => {
      if (!player.ready || !player.connected) allReady = false;
    });
    if (!allReady) return;

    this.startMatch(players);
  }

  private startMatch(players: GamePlayer[]) {
    this.gameState = this.game.createState(players);
    this.syncGameState();

    this.state.phase = Phase.IN_GAME;
    this.state.matchNumber += 1;
    this.state.winnerId = "";
    this.state.gameOverReason = "";
    this.clearReady();

    // Пока идёт партия, по коду больше никто не зайдёт.
    this.lock();

    console.log(
      `[room ${this.roomId}] партия ${this.state.matchNumber} началась ` +
        `("${this.state.gameId}")`
    );
  }

  private handleAction(client: Client, action: GameAction) {
    if (this.state.phase !== Phase.IN_GAME) return;
    if (!action || typeof action.type !== "string") return;

    const playerId = client.sessionId;

    // Клиенту не верим на слово: то, что не прошло validateAction,
    // до состояния не доходит.
    if (!this.game.validateAction(this.gameState, playerId, action)) return;

    this.gameState = this.game.applyAction(this.gameState, playerId, action);
    this.syncGameState();

    const result = this.game.checkGameOver(this.gameState);
    if (result) {
      this.finishMatch(result.winnerId, result.reason);
    }
  }

  /**
   * Партия окончена — комната переходит к результатам и остаётся жить.
   * Победа уходит в счёт за сессию, готовность сбрасывается: следующую
   * партию обоим подтверждать заново.
   */
  private finishMatch(winnerId: string | null, reason: string) {
    if (this.state.phase !== Phase.IN_GAME) return;

    this.state.phase = Phase.RESULTS;
    this.state.winnerId = winnerId ?? "";
    this.state.gameOverReason = reason;

    if (winnerId) {
      const winner = this.state.players.get(winnerId);
      if (winner) winner.wins += 1;
    }

    this.clearReady();

    // Партии больше нет — освободившееся место снова открыто.
    this.unlock();

    console.log(
      `[room ${this.roomId}] партия окончена: ${reason}, ` +
        `победитель "${winnerId ?? "нет"}"`
    );
  }

  // --- вспомогательное ----------------------------------------------------

  private syncGameState() {
    this.state.gameState = JSON.stringify(this.gameState ?? null);
  }

  private clearReady() {
    this.state.players.forEach((player) => {
      player.ready = false;
    });
  }

  private connectedPlayers(): GamePlayer[] {
    const players: GamePlayer[] = [];
    this.state.players.forEach((player, sessionId) => {
      if (player.connected) players.push({ id: sessionId, name: player.name });
    });
    return players;
  }

  /**
   * Убирает игрока насовсем. Во время партии это поражение: победа
   * достаётся тому, кто остался. Комната при этом не закрывается —
   * оставшийся ждёт нового соперника на том же коде.
   */
  private removePlayer(sessionId: string, consented: boolean) {
    const wasPlaying = this.state.phase === Phase.IN_GAME;

    this.state.players.delete(sessionId);

    if (wasPlaying) {
      const remaining = [...this.state.players.keys()];
      this.finishMatch(
        remaining.length === 1 ? remaining[0] : null,
        consented ? "resign" : "forfeit"
      );
    }

    // Хост ушёл — передаём права следующему.
    if (this.state.hostId === sessionId) {
      this.state.hostId = this.state.players.keys().next().value ?? "";
    }

    // Ждать готовности от того, кого уже нет, не надо.
    this.clearReady();

    // Место освободилось: по коду снова можно зайти.
    this.unlock();
  }
}
