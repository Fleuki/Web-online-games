import "dotenv/config";
import { hasGame } from "./games/registry";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[config] ${name}="${raw}" — не число, беру ${fallback}`);
    return fallback;
  }
  return Math.floor(value);
}

const defaultGame = process.env.DEFAULT_GAME?.trim() || "treegame";

if (!hasGame(defaultGame)) {
  throw new Error(
    `DEFAULT_GAME="${defaultGame}" не найден в реестре игр (server/games/registry.ts)`
  );
}

export const config = {
  port: intFromEnv("PORT", 2567),
  host: process.env.HOST?.trim() || "0.0.0.0",
  defaultGame,
  /** Сколько секунд игрок может отсутствовать до автопоражения. */
  reconnectTimeout: intFromEnv("RECONNECT_TIMEOUT", 60),
  isProduction: process.env.NODE_ENV === "production",
} as const;

/** Длина кода комнаты. */
export const ROOM_CODE_LENGTH = 4;

/** Имя комнаты, под которым она зарегистрирована в матчмейкере. */
export const ROOM_NAME = "game";
