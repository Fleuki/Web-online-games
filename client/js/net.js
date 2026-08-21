/**
 * Связь с сервером: вход в комнату и возвращение после обрыва.
 *
 * Наружу отдаём один объект Connection с колбэками — экранам не нужно
 * знать ни про токены реконнекта, ни про коды закрытия сокета.
 */
window.Net = (function () {
  "use strict";

  var ROOM_NAME = "game";

  /** Сервер закрыл сокет по нашей же просьбе — возвращаться не надо. */
  var CLOSE_CONSENTED = 4000;
  /** Комнаты нет, она заперта или уже закрыта. */
  var ERROR_INVALID_ROOM_ID = 4212;

  /** Столько же, сколько сервер ждёт нас в allowReconnection. */
  var RECONNECT_WINDOW_MS = 60000;
  var RECONNECT_DELAY_MS = 2000;

  function endpoint() {
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return protocol + "//" + window.location.host;
  }

  function messageFor(err) {
    if (!err) return "Не удалось подключиться";
    if (err.code === ERROR_INVALID_ROOM_ID) {
      return "Комната не найдена. Возможно, партия уже началась или все разошлись.";
    }
    return err.message || "Не удалось подключиться";
  }

  /**
   * @param {object} handlers
   *   onState(state)    — состояние комнаты изменилось
   *   onJoin(room)      — вошли (в том числе вернулись после обрыва)
   *   onReconnecting(msLeft) — связь потеряна, идут попытки вернуться
   *   onClosed(reason)  — вернуться не удалось или комната закрылась
   *   onError(message)  — не удалось войти вообще
   */
  function Connection(handlers) {
    this.handlers = handlers || {};
    this.client = new Colyseus.Client(endpoint());
    this.room = null;
    this.code = "";
    this.leaving = false;
    this.reconnectTimer = 0;
  }

  Connection.prototype.join = function (code, options) {
    var self = this;
    this.code = code;

    // Перезагрузили страницу, будучи в комнате, — возвращаемся по токену,
    // иначе сервер посчитает нас новым игроком и займёт второе место.
    var token = window.Storage.getReconnectToken(code);
    var attempt = token
      ? this.client.reconnect(token).catch(function () {
          window.Storage.setReconnectToken(code, "");
          return self.client.joinById(code, options);
        })
      : this.client.joinById(code, options);

    return attempt
      .then(function (room) {
        self.attach(room);
        return room;
      })
      .catch(function (err) {
        self.fail(err);
        throw err;
      });
  };

  /** Подписки на комнату. Вызывается и при первом входе, и после реконнекта. */
  Connection.prototype.attach = function (room) {
    var self = this;

    this.room = room;
    this.code = room.roomId;
    window.Storage.setReconnectToken(room.roomId, room.reconnectionToken);

    room.onStateChange(function (state) {
      self.emit("onState", state);
    });

    room.onLeave(function (code) {
      if (self.leaving || code === CLOSE_CONSENTED) {
        window.Storage.setReconnectToken(self.code, "");
        self.emit("onClosed", "left");
        return;
      }
      self.startReconnecting();
    });

    this.emit("onJoin", room);
  };

  /**
   * Возвращение после обрыва.
   *
   * Пробуем ровно столько, сколько нас ждёт сервер: не вышло за это время —
   * возвращаться уже некуда, там засчитано поражение.
   */
  Connection.prototype.startReconnecting = function () {
    var self = this;
    var deadline = Date.now() + RECONNECT_WINDOW_MS;
    var token = window.Storage.getReconnectToken(this.code);

    if (!token) {
      this.emit("onClosed", "lost");
      return;
    }

    this.emit("onReconnecting", RECONNECT_WINDOW_MS);

    function attempt() {
      if (self.leaving) return;

      if (Date.now() >= deadline) {
        window.Storage.setReconnectToken(self.code, "");
        self.emit("onClosed", "timeout");
        return;
      }

      self.client.reconnect(token).then(
        function (room) {
          self.attach(room);
        },
        function () {
          self.emit("onReconnecting", Math.max(0, deadline - Date.now()));
          self.reconnectTimer = window.setTimeout(attempt, RECONNECT_DELAY_MS);
        }
      );
    }

    attempt();
  };

  Connection.prototype.send = function (type, payload) {
    if (!this.room) return;
    try {
      this.room.send(type, payload);
    } catch (err) {
      // Сокет уже мёртв — реконнект разберётся, действие просто теряется.
    }
  };

  Connection.prototype.leave = function () {
    this.leaving = true;
    window.clearTimeout(this.reconnectTimer);
    window.Storage.setReconnectToken(this.code, "");
    if (this.room) this.room.leave(true);
  };

  Connection.prototype.fail = function (err) {
    this.emit("onError", messageFor(err));
  };

  Connection.prototype.emit = function (name, arg) {
    var handler = this.handlers[name];
    if (typeof handler === "function") handler(arg);
  };

  return {
    ROOM_NAME: ROOM_NAME,
    RECONNECT_WINDOW_MS: RECONNECT_WINDOW_MS,
    Connection: Connection
  };
})();
