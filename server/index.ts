import path from "node:path";
import http from "node:http";
import express from "express";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { config, ROOM_NAME } from "./config";
import { GameRoom } from "./GameRoom";
import { listGames } from "./games/registry";
import { isValidRoomCode, normalizeRoomCode } from "./roomCode";

// В разработке это server/../client, после сборки — build/../client.
// Оба раза попадаем в <корень проекта>/client.
const CLIENT_DIR = path.resolve(__dirname, "../client");
// В "exports" пакета собранного браузерного бандла нет, поэтому идём
// к нему от package.json — единственного файла, который пакет отдаёт наружу.
const COLYSEUS_CLIENT_DIST = path.join(
  path.dirname(require.resolve("colyseus.js/package.json")),
  "dist"
);

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));

// Клиентская библиотека Colyseus — отдаём свою копию из node_modules,
// чтобы не зависеть от CDN.
app.use("/vendor", express.static(COLYSEUS_CLIENT_DIST, { index: false }));

app.use(express.static(CLIENT_DIR, { extensions: ["html"] }));

/**
 * Список игр из реестра.
 *
 * Пока игра одна и лобби обходится без выбора, но точка входа для него
 * уже есть: понадобится, как только игр станет больше одной.
 */
app.get("/api/games", (_req, res) => {
  res.json({ games: listGames(), defaultGame: config.defaultGame });
});

/**
 * Создание комнаты.
 *
 * Комнату заводит сервер, а не первый игрок: лобби получает код и уходит
 * на /r/КОД, где входит уже обычным путём. Иначе пришлось бы тащить
 * открытый сокет через перезагрузку страницы.
 */
app.post("/api/rooms", async (req, res) => {
  const gameId = typeof req.body?.gameId === "string" ? req.body.gameId : undefined;

  try {
    const room = await matchMaker.createRoom(ROOM_NAME, { gameId });
    res.json({ code: room.roomId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Не удалось создать комнату";
    console.error("Не удалось создать комнату:", message);
    res.status(400).json({ error: message });
  }
});

/** Ссылка-приглашение: /r/ABCD отдаёт экран комнаты. */
app.get("/r/:code", (req, res) => {
  const code = normalizeRoomCode(req.params.code);

  if (!isValidRoomCode(code)) {
    res.status(404).sendFile(path.join(CLIENT_DIR, "index.html"));
    return;
  }

  // Приводим адрес к каноничному виду, чтобы код в строке всегда был
  // в верхнем регистре — им же делятся скриншотом.
  if (req.params.code !== code) {
    res.redirect(302, `/r/${code}`);
    return;
  }

  res.sendFile(path.join(CLIENT_DIR, "room.html"));
});

const httpServer = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define(ROOM_NAME, GameRoom);

gameServer
  .listen(config.port, config.host, undefined, () => {
    console.log(`Сервер слушает http://${config.host}:${config.port}`);
    console.log(`Игры в реестре: ${listGames().map((g) => g.id).join(", ")}`);
    console.log(`Ожидание реконнекта: ${config.reconnectTimeout} c`);
  })
  .catch((err) => {
    console.error("Не удалось запустить сервер:", err);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — останавливаюсь`);
    gameServer.gracefullyShutdown().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}
