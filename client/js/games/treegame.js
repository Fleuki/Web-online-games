/**
 * TreeGame — клиентская часть заглушки.
 *
 * Кнопка шлёт намерение { type: 'chop' }. Счёт на экране — тот, что вернул
 * сервер: локально мы ничего не прибавляем, иначе цифры разъедутся.
 */
(function () {
  "use strict";

  var TARGET_SCORE = 20;

  window.Games.register({
    id: "treegame",

    mount: function (root, api) {
      root.innerHTML =
        '<div class="scoreboard">' +
        '  <div class="score me"><span class="score-name" data-role="my-name"></span>' +
        '    <span class="score-value" data-role="my-score">0</span></div>' +
        '  <div class="score"><span class="score-name" data-role="their-name"></span>' +
        '    <span class="score-value" data-role="their-score">0</span></div>' +
        "</div>" +
        '<button type="button" class="chop-button" data-role="chop">Рубить 🪓</button>' +
        '<p class="room-code-hint" data-role="goal">Кто первым нарубит ' +
        TARGET_SCORE +
        ", тот и выиграл</p>";

      root.querySelector('[data-role="chop"]').addEventListener("click", function () {
        api.send({ type: "chop" });
      });
    },

    render: function (state, api) {
      var root = api.root;
      var scores = (state && state.scores) || {};

      var me = api.players.filter(function (player) {
        return player.sessionId === api.myId;
      })[0];
      var they = api.players.filter(function (player) {
        return player.sessionId !== api.myId;
      })[0];

      root.querySelector('[data-role="my-name"]').textContent = me ? me.name : "Вы";
      root.querySelector('[data-role="my-score"]').textContent = scores[api.myId] || 0;

      root.querySelector('[data-role="their-name"]').textContent = they
        ? they.name
        : "Соперник";
      root.querySelector('[data-role="their-score"]').textContent = they
        ? scores[they.sessionId] || 0
        : 0;

      root.querySelector('[data-role="chop"]').disabled = api.isFinished;
    }
  });
})();
