/**
 * Лобби: ник, создание комнаты, вход по коду.
 *
 * Комнату создаём здесь же, а на /r/КОД уходим уже с готовым кодом —
 * так ссылку можно кидать другу сразу, не дожидаясь второго игрока.
 */
(function () {
  "use strict";

  var CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

  var nameInput = document.getElementById("name");
  var codeInput = document.getElementById("code");
  var createButton = document.getElementById("create");
  var joinButton = document.getElementById("join");
  var statusText = document.getElementById("status");
  var errorText = document.getElementById("error");

  var busy = false;

  nameInput.value = window.Storage.getName();

  function setStatus(text) {
    statusText.textContent = text || "";
  }

  function setError(text) {
    errorText.textContent = text || "";
    errorText.hidden = !text;
  }

  function setBusy(value) {
    busy = value;
    createButton.disabled = value;
    joinButton.disabled = value;
  }

  /** Ник обязателен: без него в комнате не отличить, кто есть кто. */
  function requireName() {
    var name = window.Storage.cleanName(nameInput.value);
    if (!name) {
      setError("Введите ник — по нему друг вас узнает.");
      nameInput.focus();
      return "";
    }
    setError("");
    return window.Storage.setName(name);
  }

  function goToRoom(code) {
    window.location.href = "/r/" + code;
  }

  /**
   * Комнату заводит сервер и сразу отдаёт код — заходим в неё уже
   * на /r/КОД, обычным путём, как и второй игрок по ссылке.
   */
  function createRoom() {
    if (busy) return;
    var name = requireName();
    if (!name) return;

    setBusy(true);
    setStatus("Создаём комнату...");

    window
      .fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) throw new Error(data.error || "Сервер не отдал комнату");
          return data;
        });
      })
      .then(function (data) {
        goToRoom(data.code);
      })
      .catch(function (err) {
        setBusy(false);
        setStatus("");
        setError(err.message || "Сервер недоступен. Попробуйте ещё раз.");
      });
  }

  function joinRoom() {
    if (busy) return;
    var name = requireName();
    if (!name) return;

    var code = codeInput.value.trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      setError("Код — 4 символа. Буквы O и I, цифры 0 и 1 в кодах не встречаются.");
      codeInput.focus();
      return;
    }

    setError("");
    goToRoom(code);
  }

  createButton.addEventListener("click", createRoom);
  joinButton.addEventListener("click", joinRoom);

  nameInput.addEventListener("input", function () {
    setError("");
  });

  nameInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") createRoom();
  });

  codeInput.addEventListener("input", function () {
    // Приводим к виду кода прямо в поле: заглавные, без пробелов.
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    setError("");
  });

  codeInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") joinRoom();
  });
})();
