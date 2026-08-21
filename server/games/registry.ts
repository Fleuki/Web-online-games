import type { GameMeta, GameModule } from "./types";
import { treegame } from "./treegame";

/**
 * Реестр игровых модулей.
 *
 * Единственное место в проекте, которое знает список игр.
 * Новая игра — импорт выше и одна строка ниже.
 */
const modules: GameModule<any>[] = [treegame];

const registry = new Map<string, GameModule<any>>();

/**
 * Кладёт модуль в реестр.
 *
 * Список игр по-прежнему один — modules выше. Отдельная функция нужна,
 * чтобы тесты ядра могли подсунуть комнате фиктивную игру и проверять
 * саму комнату, а не поведение конкретной настоящей игры.
 */
export function registerGame(mod: GameModule<any>): void {
  if (registry.has(mod.meta.id)) {
    throw new Error(`Дублирующийся id игрового модуля: "${mod.meta.id}"`);
  }
  registry.set(mod.meta.id, mod);
}

for (const mod of modules) {
  registerGame(mod);
}

export function getGame(id: string): GameModule<any> | undefined {
  return registry.get(id);
}

export function hasGame(id: string): boolean {
  return registry.has(id);
}

/** Список игр для лобби. */
export function listGames(): GameMeta[] {
  return [...registry.values()].map((mod) => mod.meta);
}
