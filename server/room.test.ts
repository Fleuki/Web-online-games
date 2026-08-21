import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { GameRoom } from "./GameRoom";
import { registerGame } from "./games/registry";
import type { GameAction, GameModule, GamePlayer } from "./games/types";
import { Phase, RoomState } from "./state";

/**
 * Тесты комнаты как контейнера: она переживает партию, копит счёт за
 * сессию и умеет менять игру, никого не выгоняя.
 *
 * Конкретная игра здесь только мешала бы, поэтому в реестр кладём две
 * фиктивные: партия в них кончается одним действием, а комнате всё равно,
 * что за модуль она крутит, — это и проверяем.
 */

interface DuelState {
  scores: Record<string, number>;
  winner: string | null;
}

function duel(id: string, name: string): GameModule<DuelState> {
  const mod: GameModule<DuelState> = {
    meta: { id, name, minPlayers: 2, maxPlayers: 2, icon: "🎯" },

    createState(players: GamePlayer[]): DuelState {
      const scores: Record<string, number> = {};
      for (const player of players) scores[player.id] = 0;
      return { scores, winner: null };
    },

    validateAction(state, playerId, action: GameAction) {
      return action.type === "win" && state.winner === null && playerId in state.scores;
    },

    applyAction(state, playerId) {
      return {
        winner: playerId,
        scores: { ...state.scores, [playerId]: state.scores[playerId] + 1 },
      };
    },

    checkGameOver(state) {
      return state.winner ? { winnerId: state.winner, reason: "target" } : null;
    },
  };

  return mod;
}

const FIRST = duel("test-duel", "Дуэль");
const SECOND = duel("test-other", "Другая дуэль");

registerGame(FIRST);
registerGame(SECOND);

// --- стенд ---------------------------------------------------------------

/**
 * Комната без Colyseus вокруг.
 *
 * Создаём через Object.create: конструктор Room тянет за собой транспорт,
 * матчмейкер и таймеры рассылки, а проверять мы хотим свою логику. Всё,
 * чем комната пользуется из базового класса, здесь подменено заглушками —
 * их немного, и это ровно граница между нашим кодом и фреймворком.
 */
interface Stand {
  room: any;
  join(sessionId: string, name: string): void;
  send(sessionId: string, type: string, payload?: unknown): void;
  /** Осознанный выход. */
  quit(sessionId: string): Promise<void>;
  /** Обрыв связи: комната начинает ждать возвращения. */
  drop(sessionId: string): Promise<void>;
  /** Игрок вернулся по токену. */
  restore(sessionId: string): Promise<void>;
  /** Игрок не вернулся за отведённое время. */
  giveUp(sessionId: string): Promise<void>;
  state(): RoomState;
  player(sessionId: string): any;
  wins(sessionId: string): number;
}

async function stand(t: TestContext, gameId: string): Promise<Stand> {
  const room: any = Object.create(GameRoom.prototype);

  const handlers: Record<string, Function> = {};
  const reconnections = new Map<string, { ok: () => void; fail: () => void }>();
  const leaving = new Map<string, Promise<void>>();

  // roomId, locked и metadata на прототипе Room — аксессоры поверх приватных
  // полей, которых у собранного через Object.create объекта нет. Свой roomId
  // перекрываем, остальное наблюдаем через собственные поля стенда.
  Object.defineProperty(room, "roomId", { value: "TEST", writable: true });

  room.clients = [];
  room.isLocked = false;
  room.disposed = false;
  room.lastMetadata = null;

  room.setState = (state: RoomState) => {
    room.state = state;
  };
  room.onMessage = (type: string, handler: Function) => {
    handlers[type] = handler;
  };
  room.setMetadata = (meta: unknown) => {
    room.lastMetadata = meta;
  };
  room.lock = async () => {
    room.isLocked = true;
  };
  room.unlock = async () => {
    room.isLocked = false;
  };
  room.disconnect = async () => {
    room.disposed = true;
  };
  room.allowReconnection = (client: any) =>
    new Promise<void>((resolve, reject) => {
      reconnections.set(client.sessionId, { ok: () => resolve(), fail: () => reject(new Error("timeout")) });
    });
  // Код комнаты выдаёт матчмейкер, которого здесь нет.
  room.assignRoomCode = async () => {};

  await room.onCreate({ gameId });

  // Таймер пустой комнаты живёт пять минут — он не должен держать процесс.
  t.after(() => room.onDispose());

  function clientOf(sessionId: string) {
    return { sessionId };
  }

  function detach(sessionId: string) {
    room.clients = room.clients.filter((c: any) => c.sessionId !== sessionId);
  }

  return {
    room,

    join(sessionId, name) {
      const client = clientOf(sessionId);
      room.clients.push(client);
      room.onJoin(client, { name });
    },

    send(sessionId, type, payload) {
      const handler = handlers[type];
      assert.ok(handler, `нет обработчика "${type}"`);
      handler(clientOf(sessionId), payload);
    },

    async quit(sessionId) {
      detach(sessionId);
      await room.onLeave(clientOf(sessionId), true);
    },

    async drop(sessionId) {
      detach(sessionId);
      // Не ждём: комната держит игрока, пока он не вернулся или не истёк.
      leaving.set(sessionId, room.onLeave(clientOf(sessionId), false));
      // Даём синхронной части onLeave добежать до allowReconnection.
      await Promise.resolve();
    },

    async restore(sessionId) {
      const pending = reconnections.get(sessionId);
      assert.ok(pending, `комната не ждёт ${sessionId}`);
      room.clients.push(clientOf(sessionId));
      pending.ok();
      await leaving.get(sessionId);
    },

    async giveUp(sessionId) {
      const pending = reconnections.get(sessionId);
      assert.ok(pending, `комната не ждёт ${sessionId}`);
      pending.fail();
      await leaving.get(sessionId);
    },

    state: () => room.state as RoomState,
    player: (sessionId: string) => room.state.players.get(sessionId),
    wins: (sessionId: string) => room.state.players.get(sessionId)?.wins ?? 0,
  };
}

/** Комната с двумя игроками в лобби. Хост — «аня». */
async function room2(t: TestContext, gameId = FIRST.meta.id): Promise<Stand> {
  const s = await stand(t, gameId);
  s.join("аня", "Аня");
  s.join("боря", "Боря");
  return s;
}

/** Доводит комнату до партии и заканчивает её победой указанного игрока. */
function playMatch(s: Stand, winner: string) {
  s.send("аня", "ready", true);
  s.send("боря", "ready", true);
  assert.equal(s.state().phase, Phase.IN_GAME, "партия не началась");
  s.send(winner, "action", { type: "win" });
  assert.equal(s.state().phase, Phase.RESULTS, "партия не закончилась");
}

// --- готовность ----------------------------------------------------------

test("партия ждёт готовности обоих, а не решения хоста", async (t) => {
  const s = await room2(t);

  s.send("аня", "ready", true);
  assert.equal(s.state().phase, Phase.LOBBY, "хост запустил партию в одиночку");

  s.send("боря", "ready", true);
  assert.equal(s.state().phase, Phase.IN_GAME);
  assert.equal(s.state().matchNumber, 1);
});

test("готовность можно отозвать, и партия не начнётся", async (t) => {
  const s = await room2(t);

  s.send("аня", "ready", true);
  s.send("аня", "ready", false);
  s.send("боря", "ready", true);

  assert.equal(s.state().phase, Phase.LOBBY);
});

test("в одиночку партию не начать", async (t) => {
  const s = await stand(t, FIRST.meta.id);
  s.join("аня", "Аня");

  s.send("аня", "ready", true);
  assert.equal(s.state().phase, Phase.LOBBY);
});

test("на старте партии готовность сбрасывается — следующую подтверждать заново", async (t) => {
  const s = await room2(t);
  playMatch(s, "аня");

  assert.equal(s.player("аня").ready, false);
  assert.equal(s.player("боря").ready, false);
});

// --- смена игры внутри комнаты -------------------------------------------

test("хост меняет игру, не выгоняя игроков и не разрывая связь", async (t) => {
  const s = await room2(t);
  const before = [...s.state().players.keys()];

  s.send("аня", "select-game", { gameId: SECOND.meta.id });

  assert.equal(s.state().gameId, SECOND.meta.id);
  assert.equal(s.state().gameName, SECOND.meta.name);
  assert.deepEqual([...s.state().players.keys()], before, "состав комнаты изменился");
  assert.equal(s.player("аня").connected, true);
  assert.equal(s.player("боря").connected, true);
  assert.equal(s.state().phase, Phase.LOBBY);

  // И в новую игру можно сыграть тут же, ничего не переподключая.
  playMatch(s, "боря");
  assert.equal(s.state().gameId, SECOND.meta.id);
});

test("смена игры снимает уже нажатую готовность", async (t) => {
  const s = await room2(t);
  s.send("аня", "ready", true);

  s.send("аня", "select-game", { gameId: SECOND.meta.id });

  assert.equal(s.player("аня").ready, false, "готовность пережила смену игры");
  assert.equal(s.state().phase, Phase.LOBBY);
});

test("игру выбирает хост: чужой и неизвестный выбор не проходят", async (t) => {
  const s = await room2(t);

  s.send("боря", "select-game", { gameId: SECOND.meta.id });
  assert.equal(s.state().gameId, FIRST.meta.id, "игру поменял не хост");

  s.send("аня", "select-game", { gameId: "нет-такой-игры" });
  assert.equal(s.state().gameId, FIRST.meta.id);

  s.send("аня", "select-game", {});
  assert.equal(s.state().gameId, FIRST.meta.id);
});

test("во время партии игру не меняют", async (t) => {
  const s = await room2(t);
  s.send("аня", "ready", true);
  s.send("боря", "ready", true);

  s.send("аня", "select-game", { gameId: SECOND.meta.id });

  assert.equal(s.state().phase, Phase.IN_GAME);
  assert.equal(s.state().gameId, FIRST.meta.id);
});

test("с экрана результатов смена игры возвращает комнату к выбору", async (t) => {
  const s = await room2(t);
  playMatch(s, "аня");

  s.send("аня", "select-game", { gameId: SECOND.meta.id });

  assert.equal(s.state().phase, Phase.LOBBY);
  assert.equal(s.state().gameId, SECOND.meta.id);
  assert.equal(s.state().winnerId, "", "итог прошлой партии не убрали");
});

// --- счёт за сессию ------------------------------------------------------

test("счёт за сессию копится между партиями", async (t) => {
  const s = await room2(t);

  playMatch(s, "аня");
  assert.equal(s.wins("аня"), 1);
  assert.equal(s.wins("боря"), 0);

  playMatch(s, "аня");
  playMatch(s, "боря");

  assert.equal(s.wins("аня"), 2);
  assert.equal(s.wins("боря"), 1);
  assert.equal(s.state().matchNumber, 3);
});

test("счёт за сессию переживает смену игры", async (t) => {
  const s = await room2(t);
  playMatch(s, "аня");

  s.send("аня", "select-game", { gameId: SECOND.meta.id });
  playMatch(s, "боря");

  assert.equal(s.wins("аня"), 1, "победа в прошлой игре потерялась");
  assert.equal(s.wins("боря"), 1);
});

test("«играть снова» начинает новую партию, не трогая счёт за сессию", async (t) => {
  const s = await room2(t);
  playMatch(s, "аня");

  s.send("аня", "ready", true);
  s.send("боря", "ready", true);

  assert.equal(s.state().phase, Phase.IN_GAME);
  assert.equal(s.state().matchNumber, 2);
  assert.equal(s.wins("аня"), 1);
});

// --- конец партии --------------------------------------------------------

test("после партии игроки остаются в комнате", async (t) => {
  const s = await room2(t);
  playMatch(s, "аня");

  assert.equal(s.state().phase, Phase.RESULTS);
  assert.equal(s.state().players.size, 2);
  assert.equal(s.room.disposed, false);
  assert.equal(s.room.isLocked, false, "комната осталась запертой после партии");
});

test("«другая игра» уводит комнату из результатов в лобби", async (t) => {
  const s = await room2(t);
  playMatch(s, "аня");

  s.send("боря", "to-lobby");

  assert.equal(s.state().phase, Phase.LOBBY);
  assert.equal(s.state().gameState, "null", "состояние сыгранной партии осталось");
  assert.equal(s.state().players.size, 2);
});

test("выход из партии — поражение, но комната остаётся жить", async (t) => {
  const s = await room2(t);
  s.send("аня", "ready", true);
  s.send("боря", "ready", true);

  await s.quit("боря");

  assert.equal(s.state().phase, Phase.RESULTS);
  assert.equal(s.state().winnerId, "аня");
  assert.equal(s.state().gameOverReason, "resign");
  assert.equal(s.wins("аня"), 1);
  assert.equal(s.state().players.size, 1);
  assert.equal(s.room.disposed, false);
  assert.equal(s.room.isLocked, false, "освободившееся место не открыли");
});

test("ушедший хост передаёт права оставшемуся", async (t) => {
  const s = await room2(t);

  await s.quit("аня");

  assert.equal(s.state().hostId, "боря");
});

test("новичок на освободившееся место уводит комнату из результатов к выбору", async (t) => {
  const s = await room2(t);
  playMatch(s, "аня");
  await s.quit("боря");

  s.join("вика", "Вика");

  assert.equal(s.state().phase, Phase.LOBBY, "новичка встретил чужой итог партии");
  assert.equal(s.state().winnerId, "");
  assert.equal(s.wins("аня"), 1, "счёт за сессию сбросился на приход новичка");
  assert.equal(s.wins("вика"), 0);
});

// --- реконнект во всех состояниях ----------------------------------------

test("реконнект в лобби", async (t) => {
  const s = await room2(t);

  await s.drop("боря");
  assert.equal(s.player("боря").connected, false);
  assert.equal(s.state().phase, Phase.LOBBY);

  await s.restore("боря");
  assert.equal(s.player("боря").connected, true);
  assert.equal(s.state().players.size, 2);
});

test("реконнект в партии", async (t) => {
  const s = await room2(t);
  s.send("аня", "ready", true);
  s.send("боря", "ready", true);

  await s.drop("боря");
  assert.equal(s.state().phase, Phase.IN_GAME, "партия оборвалась на обрыве связи");

  await s.restore("боря");
  assert.equal(s.player("боря").connected, true);
  assert.equal(s.state().phase, Phase.IN_GAME);
});

test("реконнект в состоянии RESULTS", async (t) => {
  const s = await room2(t);
  playMatch(s, "аня");

  await s.drop("боря");

  // Комната не съезжает с экрана результатов и никого не выгоняет.
  assert.equal(s.state().phase, Phase.RESULTS);
  assert.equal(s.state().winnerId, "аня");
  assert.equal(s.player("боря").connected, false);
  assert.equal(s.state().players.size, 2);

  await s.restore("боря");

  assert.equal(s.player("боря").connected, true);
  assert.equal(s.state().phase, Phase.RESULTS);
  assert.equal(s.state().winnerId, "аня", "итог партии потерялся за реконнект");
  assert.equal(s.wins("аня"), 1, "счёт за сессию потерялся за реконнект");

  // И следующая партия отсюда стартует как обычно.
  s.send("аня", "ready", true);
  s.send("боря", "ready", true);
  assert.equal(s.state().phase, Phase.IN_GAME);
});

test("вернувшийся в лобби подхватывает свою готовность", async (t) => {
  const s = await room2(t);

  s.send("боря", "ready", true);
  await s.drop("боря");

  s.send("аня", "ready", true);
  assert.equal(s.state().phase, Phase.LOBBY, "партия началась без вернувшегося");

  await s.restore("боря");
  assert.equal(s.state().phase, Phase.IN_GAME);
});

test("не вернувшийся в партии проигрывает, комната переходит к результатам", async (t) => {
  const s = await room2(t);
  s.send("аня", "ready", true);
  s.send("боря", "ready", true);

  await s.drop("боря");
  await s.giveUp("боря");

  assert.equal(s.state().phase, Phase.RESULTS);
  assert.equal(s.state().winnerId, "аня");
  assert.equal(s.state().gameOverReason, "forfeit");
  assert.equal(s.state().players.size, 1);
  assert.equal(s.room.disposed, false);
});

test("не вернувшийся в лобби просто уходит, партия ни при чём", async (t) => {
  const s = await room2(t);

  await s.drop("боря");
  await s.giveUp("боря");

  assert.equal(s.state().phase, Phase.LOBBY);
  assert.equal(s.state().winnerId, "");
  assert.equal(s.state().players.size, 1);
  assert.equal(s.room.disposed, false);
});

// --- чужие действия ------------------------------------------------------

test("действия принимаются только внутри партии", async (t) => {
  const s = await room2(t);

  s.send("аня", "action", { type: "win" });
  assert.equal(s.state().phase, Phase.LOBBY, "действие сработало вне партии");

  playMatch(s, "аня");
  s.send("боря", "action", { type: "win" });
  assert.equal(s.state().winnerId, "аня", "итог переписали после конца партии");
});
