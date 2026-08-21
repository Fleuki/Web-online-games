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

for (const mod of modules) {
  if (registry.has(mod.meta.id)) {
    throw new Error(`Дублирующийся id игрового модуля: "${mod.meta.id}"`);
  }
  registry.set(mod.meta.id, mod);
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
