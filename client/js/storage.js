/**
 * Ник игрока. Регистрации нет — только localStorage.
 *
 * В приватном режиме доступ к хранилищу кидает исключение, поэтому
 * каждое обращение обёрнуто: без сохранённого ника игра работает,
 * просто ник придётся ввести заново.
 */
window.Storage = (function () {
  "use strict";

  var NAME_KEY = "wog:name";
  var MAX_NAME_LENGTH = 16;

  function cleanName(value) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  }

  function getName() {
    try {
      return cleanName(window.localStorage.getItem(NAME_KEY));
    } catch (err) {
      return "";
    }
  }

  function setName(value) {
    var name = cleanName(value);
    try {
      window.localStorage.setItem(NAME_KEY, name);
    } catch (err) {
      /* приватный режим — просто не сохраняем */
    }
    return name;
  }

  /** Токен реконнекта живёт во вкладке: перезагрузил страницу — вернулся в ту же комнату. */
  function getReconnectToken(code) {
    try {
      return window.sessionStorage.getItem("wog:reconnect:" + code) || "";
    } catch (err) {
      return "";
    }
  }

  function setReconnectToken(code, token) {
    try {
      if (token) {
        window.sessionStorage.setItem("wog:reconnect:" + code, token);
      } else {
        window.sessionStorage.removeItem("wog:reconnect:" + code);
      }
    } catch (err) {
      /* ничего страшного: не переживём перезагрузку страницы */
    }
  }

  return {
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    cleanName: cleanName,
    getName: getName,
    setName: setName,
    getReconnectToken: getReconnectToken,
    setReconnectToken: setReconnectToken
  };
})();
