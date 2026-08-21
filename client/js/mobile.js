/**
 * Мобильные мелочи, одинаковые для всех экранов.
 *
 * Долгий тап не должен звать контекстное меню, двойной — зумить,
 * а протяжка по кнопке — выделять текст.
 */
(function () {
  "use strict";

  document.addEventListener("contextmenu", function (event) {
    // В полях ввода меню «Вставить» нужно оставить.
    if (event.target.closest("input, textarea")) return;
    event.preventDefault();
  });

  document.addEventListener("selectstart", function (event) {
    if (event.target.closest("input, textarea, .room-code")) return;
    event.preventDefault();
  });

  document.addEventListener("dragstart", function (event) {
    event.preventDefault();
  });

  // iOS до сих пор зумит пинчем и двойным тапом мимо touch-action.
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (name) {
    document.addEventListener(name, function (event) {
      event.preventDefault();
    });
  });
})();
