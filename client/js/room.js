/**
 * Экран комнаты.
 *
 * Комната и партия — разные вещи. Комната живёт всё время, пока в ней
 * кто-то есть: ники, хост, счёт за сессию. Партия — временный эпизод
 * внутри неё. Поэтому экранов четыре: ник, лобби, партия, результаты, —
 * и после партии игрок остаётся в комнате, а не выпадает наружу.
 *
 * Про конкретную игру экран знает ровно одно — id из состояния комнаты.
 * Всё остальное делает модуль из Games.
 */
(function () {
  "use strict";

  var PHASE = { LOBBY: "lobby", IN_GAME: "in_game", RESULTS: "results" };

  var code = (window.location.pathname.split("/")[2] || "").toUpperCase();

  var el = {
    nameStep: document.getElementById("name-step"),
    nameStepCode: document.getElementById("name-step-code"),
    nameInput: document.getElementById("name"),
    enterButton: document.getElementById("enter"),

    roomStep: document.getElementById("room-step"),
    code: document.getElementById("code"),
    copyButton: document.getElementById("copy"),
    games: document.getElementById("games"),
    gameHint: document.getElementById("game-hint"),
    players: document.getElementById("players"),
    lobbyTally: document.getElementById("lobby-tally"),
    readyButton: document.getElementById("ready"),
    status: document.getElementById("status"),
    leaveButton: document.getElementById("leave"),

    gameStep: document.getElementById("game-step"),
    gameRoot: document.getElementById("game-root"),
    gameStatus: document.getElementById("game-status"),

    resultsStep: document.getElementById("results-step"),
    resultMatch: document.getElementById("result-match"),
    resultTitle: document.getElementById("result-title"),
    resultNote: document.getElementById("result-note"),
    resultTally: document.getElementById("result-tally"),
    againButton: document.getElementById("again"),
    otherGameButton: document.getElementById("other-game"),
    resultsStatus: document.getElementById("results-status"),

    error: document.getElementById("error"),
    overlay: document.getElementById("reconnect-overlay"),
    overlayText: document.getElementById("reconnect-text")
  };

  var connection = null;
  var myId = "";
  var lastState = null;

  /** Каталог игр с сервера — источник правды для выбора внутри комнаты. */
  var catalog = [];

  /** Смонтированная партия: { id, module }. Между партиями — null. */
  var mounted = null;

  /**
   * Один и тот же объект на всю жизнь экрана: модуль сохраняет его при
   * mount и читает поля на каждом кадре, поэтому его правим, а не заменяем.
   */
  var gameApi = {
    root: el.gameRoot,
    myId: "",
    players: [],
    send: function (action) {
      if (connection) connection.send("action", action);
    }
  };

  /** Обратный отсчёт ожидания соперника. */
  var waiting = { id: "", name: "", until: 0, timer: 0, target: null };

  // --- мелкие помощники ---------------------------------------------------

  function show(section) {
    el.nameStep.hidden = section !== "name";
    el.roomStep.hidden = section !== "room";
    el.gameStep.hidden = section !== "game";
    el.resultsStep.hidden = section !== "results";
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

  /** MapSchema -> обычный массив. */
  function playerList(state) {
    var players = [];
    state.players.forEach(function (player, sessionId) {
      players.push({
        sessionId: sessionId,
        name: player.name,
        connected: player.connected,
        ready: player.ready,
        wins: player.wins || 0
      });
    });
    return players;
  }

  function byId(players, sessionId) {
    for (var i = 0; i < players.length; i++) {
      if (players[i].sessionId === sessionId) return players[i];
    }
    return null;
  }

  function rivalOf(players) {
    for (var i = 0; i < players.length; i++) {
      if (players[i].sessionId !== myId) return players[i];
    }
    return null;
  }

  function tag(text, className) {
    var element = document.createElement("span");
    element.className = "tag" + (className ? " " + className : "");
    element.textContent = text;
    return element;
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
        gameApi.myId = myId;
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

    unmountGame();
    show("room");
    setError(
      "Связь потеряна. Вернуться в комнату не удалось — если шла партия, " +
        "вам засчитано поражение."
    );
    el.readyButton.hidden = true;
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

    lastState = state;
    el.code.textContent = code;

    var players = playerList(state);

    if (state.phase === PHASE.IN_GAME) {
      show("game");
      renderMatch(state, players);
    } else {
      unmountGame();
      if (state.phase === PHASE.RESULTS) {
        show("results");
        renderResults(state, players);
      } else {
        show("room");
        renderLobby(state, players);
      }
    }

    updateWaiting(state, players);
  }

  // --- лобби --------------------------------------------------------------

  function renderLobby(state, players) {
    renderGames(state);
    renderPlayers(state, players);
    renderTally(el.lobbyTally, players, state.matchNumber > 0);
    renderReady(state, players, el.readyButton, el.status, "Готов", "Не готов");
  }

  /**
   * Список игр. Хосту он кликабельный, остальным — просто витрина:
   * выбирает один, подтверждают оба.
   */
  function renderGames(state) {
    var iAmHost = state.hostId === myId;

    el.games.innerHTML = "";

    var games = catalog.length
      ? catalog
      : [{ id: state.gameId, name: state.gameName, icon: "🎲", maxPlayers: 2 }];

    games.forEach(function (game) {
      var item = document.createElement("li");
      item.className = "game-option" + (game.id === state.gameId ? " selected" : "");

      var icon = document.createElement("span");
      icon.className = "game-icon";
      icon.textContent = game.icon || "🎲";
      item.appendChild(icon);

      var name = document.createElement("span");
      name.className = "game-title";
      name.textContent = game.name;
      item.appendChild(name);

      if (game.id === state.gameId) item.appendChild(tag("выбрана"));

      if (iAmHost && game.id !== state.gameId) {
        item.classList.add("pickable");
        item.setAttribute("role", "button");
        item.setAttribute("tabindex", "0");
        item.addEventListener("click", function () {
          connection.send("select-game", { gameId: game.id });
        });
      }

      el.games.appendChild(item);
    });

    if (!iAmHost) {
      el.gameHint.textContent = "Игру выбирает хост";
    } else if (games.length < 2) {
      el.gameHint.textContent = "Пока в наборе одна игра";
    } else {
      el.gameHint.textContent = "Нажмите на игру, чтобы поменять";
    }
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
      if (player.connected && player.ready) item.appendChild(tag("готов", "ok"));

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

  /** Счёт за сессию: «Артемий 3 : 2 Петя». Себя показываем слева. */
  function renderTally(target, players, force) {
    var me = byId(players, myId);
    var rival = rivalOf(players);

    var played = players.some(function (player) {
      return player.wins > 0;
    });

    if (!rival || !me || (!played && !force)) {
      target.hidden = true;
      target.textContent = "";
      return;
    }

    target.hidden = false;
    target.innerHTML = "";

    target.appendChild(tallyName(me.name));
    var score = document.createElement("span");
    score.className = "tally-score";
    score.textContent = me.wins + " : " + rival.wins;
    target.appendChild(score);
    target.appendChild(tallyName(rival.name));
  }

  function tallyName(text) {
    var element = document.createElement("span");
    element.className = "tally-name";
    element.textContent = text;
    return element;
  }

  /**
   * Кнопка готовности и строка под ней.
   *
   * Партию запускает согласие обоих, а не решение хоста: после проигранной
   * рубки человеку нужна пара секунд, и отнимать их у него нельзя.
   */
  function renderReady(state, players, button, statusEl, readyLabel, cancelLabel) {
    var me = byId(players, myId);
    var rival = rivalOf(players);
    var everyoneHere =
      players.length === 2 &&
      players.every(function (player) {
        return player.connected;
      });

    button.hidden = false;
    button.disabled = !everyoneHere || !me;
    button.textContent = me && me.ready ? cancelLabel : readyLabel;
    button.classList.toggle("secondary", !!(me && me.ready));

    if (!everyoneHere) {
      // Про отвалившегося напишет updateWaiting — не спорим с ним.
      statusEl.textContent = players.length < 2 ? "Ждём второго игрока..." : "";
      return;
    }

    if (me && me.ready && rival && rival.ready) {
      statusEl.textContent = "Начинаем...";
    } else if (me && me.ready) {
      statusEl.textContent = "Ждём: " + rival.name;
    } else if (rival && rival.ready) {
      statusEl.textContent = rival.name + " готов. Ждём вас.";
    } else {
      statusEl.textContent = "Партия начнётся, когда оба подтвердят готовность";
    }
  }

  // --- результаты ---------------------------------------------------------

  function renderResults(state, players) {
    el.resultMatch.textContent =
      "Партия " + state.matchNumber + " · " + (state.gameName || "");
    el.resultTitle.textContent = resultTitle(state, players);
    el.resultNote.textContent = resultNote(state);
    el.resultNote.hidden = !el.resultNote.textContent;

    renderTally(el.resultTally, players, true);
    renderReady(
      state,
      players,
      el.againButton,
      el.resultsStatus,
      "Играть снова",
      "Передумал"
    );

    // «Другая игра» открыта обоим: это возврат к выбору, а не сам выбор.
    el.otherGameButton.hidden = false;
  }

  function resultTitle(state, players) {
    if (!state.winnerId) return "Ничья";
    if (state.winnerId === myId) return "Вы выиграли!";

    var winner = byId(players, state.winnerId);
    return "Выиграл " + (winner ? winner.name : "соперник");
  }

  function resultNote(state) {
    var won = state.winnerId === myId;

    if (state.gameOverReason === "forfeit") {
      return won
        ? "Соперник не вернулся в игру — победа засчитана вам."
        : "Вы не вернулись вовремя — засчитано поражение.";
    }

    if (state.gameOverReason === "resign") {
      return won ? "Соперник вышел из партии." : "Вы вышли из партии.";
    }

    return "";
  }

  // --- ожидание отвалившегося ---------------------------------------------

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

    if (!missing) {
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
    waiting.target = statusFor(state.phase);

    if (!waiting.timer) {
      waiting.timer = window.setInterval(tickWaiting, 1000);
    }
    tickWaiting();
  }

  function statusFor(phase) {
    if (phase === PHASE.IN_GAME) return el.gameStatus;
    if (phase === PHASE.RESULTS) return el.resultsStatus;
    return el.status;
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
   * уже поставил renderReady или renderMatch.
   */
  function stopWaiting() {
    if (waiting.timer) {
      window.clearInterval(waiting.timer);
      waiting.timer = 0;
    }
    waiting.id = "";
    waiting.target = null;
  }

  // --- партия -------------------------------------------------------------

  function renderMatch(state, players) {
    gameApi.players = players;

    var module = mountGame(state.gameId);
    if (!module) return;

    var gameState = null;
    try {
      gameState = state.gameState ? JSON.parse(state.gameState) : null;
    } catch (err) {
      gameState = null;
    }

    module.render(gameState, gameApi);

    // Строку статуса переопределит updateWaiting, если есть кого ждать.
    el.gameStatus.textContent = "";
  }

  /**
   * Модуль монтируется на партию, а не на комнату: следующая начинается
   * с чистого экрана, даже если игра та же.
   */
  function mountGame(gameId) {
    if (mounted && mounted.id === gameId) return mounted.module;
    if (mounted) unmountGame();

    var module = window.Games.get(gameId);
    if (!module) {
      setError('Игра "' + gameId + '" не установлена на этом клиенте.');
      return null;
    }

    module.mount(el.gameRoot, gameApi);
    mounted = { id: gameId, module: module };
    setError("");

    return module;
  }

  function unmountGame() {
    if (!mounted) return;
    if (typeof mounted.module.unmount === "function") {
      mounted.module.unmount(el.gameRoot);
    }
    el.gameRoot.innerHTML = "";
    mounted = null;
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

  // --- каталог игр --------------------------------------------------------

  function loadCatalog() {
    window
      .fetch("/api/games")
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        catalog = (data && data.games) || [];
        // Список пришёл позже состояния — перерисовываем лобби.
        if (lastState && lastState.phase === PHASE.LOBBY) render(lastState);
      })
      .catch(function () {
        // Без каталога комната работает: покажем ту игру, что уже выбрана.
      });
  }

  // --- запуск -------------------------------------------------------------

  function toggleReady() {
    if (!connection || !lastState) return;
    var me = byId(playerList(lastState), myId);
    connection.send("ready", !(me && me.ready));
  }

  el.enterButton.addEventListener("click", submitName);
  el.nameInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") submitName();
  });
  el.nameInput.addEventListener("input", function () {
    setError("");
  });

  el.copyButton.addEventListener("click", copyLink);
  el.readyButton.addEventListener("click", toggleReady);
  el.againButton.addEventListener("click", toggleReady);

  el.otherGameButton.addEventListener("click", function () {
    connection.send("to-lobby");
  });

  el.leaveButton.addEventListener("click", function () {
    connection.leave();
    window.location.href = "/";
  });

  loadCatalog();

  var savedName = window.Storage.getName();
  if (savedName) {
    connect(savedName);
  } else {
    askName();
  }
})();
