/**
 * Клиентский реестр игр — зеркало серверного.
 *
 * Модуль игры реализует:
 *   mount(root, api)   — один раз строит разметку внутри root
 *   render(state, api) — рисует состояние партии
 *   unmount(root)      — прибирает за собой (необязательно)
 *
 * api = { myId, players, isFinished, winnerId, send(action) }
 *
 * Экран комнаты не знает, что рисует модуль: канвас, DOM или что угодно.
 * Новая игра — файл рядом и одна строка Games.register(...).
 */
window.Games = (function () {
  "use strict";

  var modules = {};

  function register(module) {
    if (!module || !module.id) throw new Error("У игрового модуля нет id");
    modules[module.id] = module;
  }

  function get(id) {
    return modules[id] || null;
  }

  return { register: register, get: get };
})();
