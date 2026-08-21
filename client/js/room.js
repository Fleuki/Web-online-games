/**
 * Экран комнаты: ник, код, список игроков, старт и сама партия.
 *
 * Про конкретную игру знает ровно одно — id из состояния комнаты.
 * Всё остальное делает модуль из Games.
 */
(function () {
  "use strict";

  var PHASE = { LOBBY: "lobby", PLAYING: "playing", FINISHED: "finished" };

  var code = (window.location.pathname.split("/")[2] || "").toUpperCase();

  var el = {
    nameStep: document.getElementById("name-step"),
    nameStepCode: document.getElementById("name-step-code"),
    nameInput: document.getElementById("name"),
    enterButton: document.getElementById("enter"),

    roomStep: document.getElementById("room-step"),
    code: document.getElementById("code"),
    gameName: document.getElementById("game-name"),
    copyButton: document.getElementById("copy"),
    players: document.getElementById("players"),
    startButton: document.getElementById("start"),
    status: document.getElementById("status"),

    gameStep: document.getElementById("game-step"),
    gameRoot: document.getElementById("game-root"),
    gameStatus: document.getElementById("game-status"),
    backButton: document.getElementById("back"),

    error: document.getElementById("error"),
    overlay: document.getElementById("reconnect-overlay"),
    overlayText: document.getElementById("reconnect-text")
  };

  var connection = null;
  var myId = "";
  var gameModule = null;
  var gameMounted = false;

  /** Обратный отсчёт ожидания соперника. */
  var waiting = { id: "", name: "", until: 0, timer: 0, target: null };

  // --- мелкие помощники ---------------------------------------------------

  function show(section) {
    el.nameStep.hidden = section !== "name";
    el.roomStep.hidden = section !== "room";
    el.gameStep.hidden = section !== "game";
  }

  function setError(text) {
    el.error.textContent = text || "";
    el.error.hidden = !text;
  }

  function plural(n, one, few, many) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  /** MapSchema -> обычный массив, отсортированный стабильно. */
  function playerList(state) {
    var players = [];
    state.players.forEach(function (player, sessionId) {
      players.push({
        sessionId: sessionId,
        name: player.name,
        connected: player.connected
      });
    });
    return players;
  }

  // --- шаг «ник» ----------------------------------------------------------

  function askName() {
    el.nameStepCode.textContent = code;
    el.nameInput.value = window.Storage.getName();
    show("name");
    el.nameInput.focus();
  }

  function submitName() {
    var name = window.Storage.cleanName(el.nameInput.value);
    if (!name) {
      setError("Введите ник — по нему друг вас узнает.");
      el.nameInput.focus();
      return;
    }
    setError("");
    window.Storage.setName(name);
    connect(name);
  }

  // --- связь --------------------------------------------------------------

  function connect(name) {
    show("room");
    el.code.textContent = code;
    el.status.textContent = "Подключаемся...";

    connection = new window.Net.Connection({
      onJoin: function (room) {
        myId = room.sessionId;
        hideOverlay();
        el.status.textContent = "";
        setError("");
      },
      onState: render,
      onReconnecting: showOverlay,
      onClosed: onClosed,
      onError: function (message) {
        show("room");
        el.status.textContent = "";
        setError(message);
      }
    });

    connection.join(code, { name: name }).catch(function () {
      /* сообщение уже показано в onError */
    });
  }

  function onClosed(reason) {
    hideOverlay();
    if (reason === "left") return;
    setError(
      "Связь потеряна. Вернуться в комнату не удалось — если шла партия, " +
        "вам засчитано поражение."
    );
    el.startButton.hidden = true;
  }

  // --- оверлей переподключения --------------------------------------------

  function showOverlay(msLeft) {
    el.overlay.hidden = false;
    var seconds = Math.ceil((msLeft || 0) / 1000);
    el.overlayText.textContent = seconds
      ? "Осталось " + seconds + " " + plural(seconds, "секунда", "секунды", "секунд")
      : "Возвращаемся в комнату";
  }

  function hideOverlay() {
    el.overlay.hidden = true;
  }

  // --- отрисовка ----------------------------------------------------------

  function render(state) {
    if (!state) return;

    el.code.textContent = code;
    el.gameName.textContent = state.gameName || "";

    var players = playerList(state);

    if (state.phase === PHASE.LOBBY) {
      show("room");
      renderPlayers(state, players);
      renderStartButton(state, players);
    } else {
      show("game");
      renderGame(state, players);
    }

    updateWaiting(state, players);
  }

  function renderPlayers(state, players) {
    el.players.innerHTML = "";

    players.forEach(function (player) {
      var item = document.createElement("li");

      var dot = document.createElement("span");
      dot.className = "dot" + (player.connected ? "" : " offline");
      item.appendChild(dot);

      var name = document.createElement("span");
      name.className = "player-name";
      name.textContent = player.name;
      item.appendChild(name);

      if (player.sessionId === myId) item.appendChild(tag("вы"));
      if (player.sessionId === state.hostId) item.appendChild(tag("хост"));

      el.players.appendChild(item);
    });

    // Пустой слот, чтобы было видно: ждём второго.
    if (players.length < 2) {
      var empty = document.createElement("li");
      empty.className = "slot-empty";
      empty.textContent = "Ждём второго игрока...";
      el.players.appendChild(empty);
    }
  }

  function tag(text) {
    var element = document.createElement("span");
    element.className = "tag";
    element.textContent = text;
    return element;
  }

  function renderStartButton(state, players) {
    var iAmHost = state.hostId === myId;
    var everyoneHere =
      players.length === 2 &&
      players.every(function (player) {
        return player.connected;
      });

    el.startButton.hidden = !iAmHost;
    el.startButton.disabled = !everyoneHere;

    if (!iAmHost) {
      el.status.textContent = everyoneHere ? "Ждём, пока хост начнёт партию" : "";
    } else {
      el.status.textContent = everyoneHere ? "" : "Кнопка оживёт, когда придёт второй";
    }
  }

  /**
   * Кто-то отвалился — показываем это обоим, с обратным отсчётом.
   *
   * Секунды считаем у себя, от момента, когда увидели обрыв: серверное
   * время сюда не приезжает, а часы на телефоне могут врать.
   */
  function updateWaiting(state, players) {
    var missing = players.filter(function (player) {
      return !player.connected && player.sessionId !== myId;
    })[0];

    if (!missing || state.phase === PHASE.FINISHED) {
      stopWaiting();
      return;
    }

    // Ждём кого-то нового — заводим отсчёт заново. Тот же игрок —
    // продолжаем начатый, иначе таймер сбрасывался бы на каждом обновлении.
    if (waiting.id !== missing.sessionId) {
      waiting.id = missing.sessionId;
      waiting.until = Date.now() + (state.reconnectTimeout || 60) * 1000;
    }

    waiting.name = missing.name;
    waiting.target = state.phase === PHASE.LOBBY ? el.status : el.gameStatus;

    if (!waiting.timer) {
      waiting.timer = window.setInterval(tickWaiting, 1000);
    }
    tickWaiting();
  }

  function tickWaiting() {
    if (!waiting.id || !waiting.target) return;

    var left = Math.max(0, Math.round((waiting.until - Date.now()) / 1000));

    waiting.target.textContent = left
      ? waiting.name +
        " потерял связь. Ждём " +
        left +
        " " +
        plural(left, "секунду", "секунды", "секунд") +
        "..."
      : waiting.name + " не вернулся.";
  }

  /**
   * Останавливаем отсчёт, но текст не трогаем: его на этом же проходе
   * уже поставил renderStartButton или renderGame.
   */
  function stopWaiting() {
    if (waiting.timer) {
      window.clearInterval(waiting.timer);
      waiting.timer = 0;
    }
    waiting.id = "";
    waiting.target = null;
  }

  // --- игра ---------------------------------------------------------------

  function renderGame(state, players) {
    if (!gameModule) {
      gameModule = window.Games.get(state.gameId);
    }

    if (!gameModule) {
      setError('Игра "' + state.gameId + '" не установлена на этом клиенте.');
      return;
    }

    var api = {
      root: el.gameRoot,
      myId: myId,
      players: players,
      isFinished: state.phase === PHASE.FINISHED,
      winnerId: state.winnerId,
      send: function (action) {
        connection.send("action", action);
      }
    };

    if (!gameMounted) {
      gameModule.mount(el.gameRoot, api);
      gameMounted = true;
    }

    var gameState = null;
    try {
      gameState = state.gameState ? JSON.parse(state.gameState) : null;
    } catch (err) {
      gameState = null;
    }

    gameModule.render(gameState, api);

    if (state.phase === PHASE.FINISHED) {
      el.gameStatus.textContent = resultText(state, players);
      el.backButton.hidden = false;
    } else {
      // Строку статуса переопределит updateWaiting, если есть кого ждать.
      el.gameStatus.textContent = "";
    }
  }

  function resultText(state, players) {
    if (!state.winnerId) return "Партия окончена: ничья.";

    var winner = players.filter(function (player) {
      return player.sessionId === state.winnerId;
    })[0];
    var won = state.winnerId === myId;

    if (state.gameOverReason === "forfeit") {
      return won
        ? "Соперник не вернулся в игру. Вам засчитана победа."
        : "Вы не вернулись вовремя. Засчитано поражение.";
    }

    if (state.gameOverReason === "resign") {
      return won ? "Соперник вышел из игры. Победа за вами." : "Вы вышли из игры.";
    }

    return won ? "Вы выиграли!" : "Выиграл " + (winner ? winner.name : "соперник") + ".";
  }

  // --- ссылка -------------------------------------------------------------

  function copyLink() {
    var link = window.location.origin + "/r/" + code;

    function done() {
      el.copyButton.textContent = "Ссылка скопирована";
      window.setTimeout(function () {
        el.copyButton.textContent = "Скопировать ссылку";
      }, 1600);
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(done, fallbackCopy);
      return;
    }
    fallbackCopy();

    // http:// и старые мобильные браузеры — clipboard API там недоступен.
    function fallbackCopy() {
      var field = document.createElement("input");
      field.value = link;
      field.setAttribute("readonly", "readonly");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      field.setSelectionRange(0, link.length);
      try {
        document.execCommand("copy");
        done();
      } catch (err) {
        el.copyButton.textContent = link;
      }
      document.body.removeChild(field);
    }
  }

  // --- запуск -------------------------------------------------------------

  el.enterButton.addEventListener("click", submitName);
  el.nameInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") submitName();
  });
  el.nameInput.addEventListener("input", function () {
    setError("");
  });

  el.copyButton.addEventListener("click", copyLink);

  el.startButton.addEventListener("click", function () {
    connection.send("start");
  });

  el.backButton.addEventListener("click", function () {
    connection.leave();
    window.location.href = "/";
  });

  var savedName = window.Storage.getName();
  if (savedName) {
    connect(savedName);
  } else {
    askName();
  }
})();
