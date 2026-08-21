import { randomInt } from "node:crypto";
import { matchMaker } from "@colyseus/core";
import { ROOM_CODE_LENGTH } from "./config";

/**
 * Алфавит кода комнаты: A-Z и 0-9 без пар, которые путают при переписывании
 * с экрана, — 0/O и 1/I выброшены целиком.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** Сколько раз пробуем сгенерировать код, прежде чем сдаться. */
const MAX_ATTEMPTS = 20;

function randomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    // randomInt даёт равномерное распределение, в отличие от Math.random() % n
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Приводит введённое человеком к виду кода: убирает пробелы и регистр.
 *
 * Ничего не «исправляет»: 0/O и 1/I выброшены из алфавита с обеих сторон,
 * поэтому путать нечего — такой символ просто не пройдёт валидацию.
 */
export function normalizeRoomCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function isValidRoomCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/**
 * Свободный код комнаты.
 *
 * Проверяем через матчмейкер, а не через локальный список: при нескольких
 * процессах комнаты живут в общем драйвере.
 */
export async function generateRoomCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = randomCode();
    const existing = await matchMaker.query({ roomId: code });
    if (existing.length === 0) return code;
  }
  throw new Error("Не удалось подобрать свободный код комнаты");
}
