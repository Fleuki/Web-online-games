/**
 * TreeGame — клиентская часть.
 *
 * Свой ствол на весь экран, счёт соперника сверху. Тап по левой или правой
 * половине экрана — удар с этой стороны, на десктопе то же самое делают
 * стрелки.
 *
 * Считает всё сервер. Клиент только предсказывает исход удара по тем же
 * данным и тому же правилу, чтобы анимация начиналась сразу, а не через
 * круг до сервера и обратно; расхождения он затем принимает как истину.
 */
(function () {
  "use strict";

  var COLORS = {
    outline: "#141210",
    skyTop: "#a6ebf5",
    skyLow: "#c8f4f8",
    cloud: "#f6fcff",
    ground: "#5ec93c",
    groundDark: "#46ab2a",
    trunk: "#8a5527",
    trunkHi: "#e3b483",
    trunkCap: "#5ec93a",
    leaf: "#5ec93a",
    leafDot: "#ffc63d",
    skin: "#f7d3a6",
    hat: "#4b3520",
    hatCuff: "#7d5a33",
    beard: "#a8703c",
    shirt: "#ea5348",
    shirtDark: "#c23a30",
    rival: "#3f7fd0",
    pants: "#31405c",
    boots: "#7a4a25",
    axeHead: "#d9dee5",
    axeHandle: "#9c6b3a",
    stun: "#ff4a3d",
    chip: "#c98d51"
  };

  var CHOP_MS = 130;   // взмах топора
  var SHIFT_MS = 110;  // ствол оседает на сегмент
  var SHAKE_MS = 320;  // тряска от оглушения

  /**
   * Сколько ждать после последнего удара, прежде чем поверить серверу,
   * что счёт меньше предсказанного. Пока игрок частит, ответы приходят с
   * задержкой, и снимать предсказание рано.
   */
  var RECONCILE_MS = 500;

  var view = null;

  /**
   * Стили модуля живут здесь же: новая игра не должна требовать правок
   * в общем style.css.
   */
  var STYLE_ID = "treegame-style";
  var STYLE = [
    ".tree-canvas {",
    "  position: fixed;",
    "  inset: 0;",
    "  z-index: 0;",
    "  display: block;",
    "  width: 100%;",
    "  height: 100%;",
    "  touch-action: manipulation;",
    "}",
    ".tree-hint {",
    "  position: fixed;",
    "  left: 50%;",
    "  bottom: calc(18px + env(safe-area-inset-bottom, 0px));",
    "  z-index: 1;",
    "  transform: translateX(-50%);",
    "  margin: 0;",
    "  padding: 9px 14px;",
    "  border-radius: 999px;",
    "  background: rgba(20, 18, 16, 0.62);",
    "  color: #fff;",
    "  font-size: 13px;",
    "  white-space: nowrap;",
    "  pointer-events: none;",
    "}",
    "@media (max-width: 380px) { .tree-hint { font-size: 12px; } }"
  ].join("\n");

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }


  function now() {
    return Date.now();
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  /** Тот же mulberry32, что на сервере, — облака расставляем от сида партии. */
  function mulberry32(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6d2b79f5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function easeOut(t) {
    return 1 - (1 - t) * (1 - t);
  }

  /** Прогресс анимации от 0 до 1; 1 — уже закончилась. */
  function progress(startedAt, duration) {
    if (!startedAt) return 1;
    return clamp((now() - startedAt) / duration, 0, 1);
  }

  /** Сегмент ствола по абсолютному номеру. Окно приходит с сервера обрезанным. */
  function segmentAt(state, index) {
    if (!state || !state.trunk.length) return null;
    return state.trunk[index - state.trunk[0].index] || null;
  }

  // --- состояние экрана ---------------------------------------------------

  function createView(root, api) {
    var canvas = document.createElement("canvas");
    canvas.className = "tree-canvas";

    var hint = document.createElement("p");
    hint.className = "tree-hint";
    hint.textContent = "Тапайте по левой или правой половине экрана";

    root.appendChild(canvas);
    root.appendChild(hint);

    return {
      canvas: canvas,
      ctx: canvas.getContext("2d"),
      hint: hint,
      api: api,
      state: null,
      players: [],

      // Предсказанное состояние: им рисуем, сервер его поправляет.
      score: 0,
      stunUntil: 0,
      lastChopAt: 0,
      seenStun: 0,

      side: "right",
      chopAt: 0,
      shiftAt: 0,
      shakeAt: 0,
      chips: [],
      frame: 0,
      width: 0,
      height: 0,
      dpr: 1
    };
  }

  function resize() {
    var width = window.innerWidth;
    var height = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);

    view.width = width;
    view.height = height;
    view.dpr = dpr;
    view.canvas.width = Math.round(width * dpr);
    view.canvas.height = Math.round(height * dpr);
    view.canvas.style.width = width + "px";
    view.canvas.style.height = height + "px";
  }

  /** Размеры сцены пересчитываются от экрана: от 360px и выше. */
  function metrics() {
    var height = view.height;
    var width = view.width;
    var groundH = clamp(height * 0.16, 64, 150);

    return {
      width: width,
      height: height,
      groundY: height - groundH,
      groundH: groundH,
      segH: clamp(height * 0.15, 54, 120),
      trunkW: clamp(width * 0.19, 56, 108),
      cx: width / 2
    };
  }

  // --- ввод ---------------------------------------------------------------

  function chop(side) {
    if (!view.state || view.gameOver) return;
    if (now() < view.stunUntil) return; // оглушён — управление потеряно
    if (view.score >= view.state.targetScore) return;

    var segment = segmentAt(view.state, view.score);

    view.side = side;
    view.chopAt = now();
    view.lastChopAt = now();

    if (segment && segment.branch === side) {
      // Удар в ветку: то же правило, что и на сервере.
      view.stunUntil = now() + view.state.stunDurationMs;
      view.shakeAt = now();
    } else {
      view.score += 1;
      view.shiftAt = now();
      spawnChips(side);
    }

    view.api.send({ type: "chop", side: side });
  }

  function spawnChips(side) {
    var m = metrics();
    var dir = side === "left" ? 1 : -1;

    for (var i = 0; i < 7; i++) {
      view.chips.push({
        x: m.cx - dir * m.trunkW * 0.5,
        y: m.groundY - m.segH * 0.45,
        vx: dir * (60 + Math.random() * 190),
        vy: -110 - Math.random() * 190,
        size: 3 + Math.random() * 4,
        born: now()
      });
    }
    if (view.chips.length > 60) view.chips.splice(0, view.chips.length - 60);
  }

  function bindInput() {
    view.onPointer = function (event) {
      if (event.target !== view.canvas) return;
      event.preventDefault();
      chop(event.clientX < view.width / 2 ? "left" : "right");
    };

    view.onKey = function (event) {
      if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") {
        event.preventDefault();
        chop("left");
      } else if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") {
        event.preventDefault();
        chop("right");
      }
    };

    view.onResize = resize;

    view.canvas.addEventListener("pointerdown", view.onPointer);
    window.addEventListener("keydown", view.onKey);
    window.addEventListener("resize", view.onResize);
    window.addEventListener("orientationchange", view.onResize);
  }

  // --- согласование с сервером --------------------------------------------

  function reconcile(state, api) {
    view.state = state;
    view.players = api.players;
    view.gameOver = api.isFinished;

    var mine = state.players[api.myId];
    if (!mine) return;

    /*
     * Оглушение начинаем отсчитывать по своим часам с момента, когда узнали
     * о нём: stunnedUntil — время сервера, а часы на телефоне могут врать.
     */
    if (mine.stunnedUntil > view.seenStun) {
      view.seenStun = mine.stunnedUntil;
      if (now() >= view.stunUntil) {
        view.stunUntil = now() + state.stunDurationMs;
        view.shakeAt = now();
      }
    }

    if (mine.score > view.score) {
      // Сервер впереди — принимаем сразу.
      view.score = mine.score;
    } else if (mine.score < view.score && now() - view.lastChopAt > RECONCILE_MS) {
      // Предсказание не сбылось, и новых ударов давно не было.
      view.score = mine.score;
    }
  }

  // --- отрисовка ----------------------------------------------------------

  function stroke(ctx, width) {
    ctx.lineWidth = width || 3;
    ctx.strokeStyle = COLORS.outline;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  function roundRect(ctx, x, y, w, h, r) {
    var radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function drawSky(ctx, m) {
    var sky = ctx.createLinearGradient(0, 0, 0, m.groundY);
    sky.addColorStop(0, COLORS.skyTop);
    sky.addColorStop(1, COLORS.skyLow);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, m.width, m.height);

    if (!view.state) return;

    // Облака расставлены от сида партии — у обоих игроков одинаковые.
    var random = mulberry32(view.state.seed);
    ctx.fillStyle = COLORS.cloud;
    for (var i = 0; i < 5; i++) {
      var x = random() * m.width;
      var y = 40 + random() * (m.groundY * 0.55);
      var r = 16 + random() * 26;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.arc(x + r * 0.9, y + r * 0.15, r * 0.75, 0, Math.PI * 2);
      ctx.arc(x - r * 0.85, y + r * 0.2, r * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawGround(ctx, m) {
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, m.groundY, m.width, m.groundH);
    ctx.fillStyle = COLORS.groundDark;
    ctx.fillRect(0, m.groundY + m.groundH * 0.42, m.width, m.groundH * 0.58);

    ctx.beginPath();
    ctx.moveTo(0, m.groundY);
    ctx.lineTo(m.width, m.groundY);
    stroke(ctx, 3);
  }

  function drawBranch(ctx, cx, bottomY, m, side) {
    var dir = side === "left" ? -1 : 1;
    var edge = cx + dir * m.trunkW * 0.5;
    var cy = bottomY - m.segH * 0.5;
    var len = m.trunkW * 1.15;
    var thick = m.segH * 0.2;

    ctx.beginPath();
    ctx.moveTo(edge, cy - thick * 0.5);
    ctx.lineTo(edge + dir * len, cy - thick * 0.5 - m.segH * 0.16);
    ctx.lineTo(edge + dir * len, cy + thick * 0.5 - m.segH * 0.16);
    ctx.lineTo(edge, cy + thick * 0.5);
    ctx.closePath();
    ctx.fillStyle = COLORS.trunk;
    ctx.fill();
    stroke(ctx, 3);

    var tipX = edge + dir * len;
    var tipY = cy - m.segH * 0.16;
    var r = m.segH * 0.34;

    /*
     * Крона — три круга. Если обводить каждый, внутри кроны остаются лишние
     * линии, поэтому сначала кладём те же круги увеличенными и цветом
     * обводки, а сверху — заливку. Получается общий контур без швов.
     */
    var blobs = [
      { x: tipX + dir * r * 0.35, y: tipY, r: r },
      { x: tipX + dir * r * 1.1, y: tipY - r * 0.35, r: r * 0.7 },
      { x: tipX + dir * r * 0.5, y: tipY - r * 0.75, r: r * 0.62 }
    ];

    ctx.fillStyle = COLORS.outline;
    for (var i = 0; i < blobs.length; i++) {
      ctx.beginPath();
      ctx.arc(blobs[i].x, blobs[i].y, blobs[i].r + 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = COLORS.leaf;
    for (var j = 0; j < blobs.length; j++) {
      ctx.beginPath();
      ctx.arc(blobs[j].x, blobs[j].y, blobs[j].r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = COLORS.leafDot;
    ctx.beginPath();
    ctx.arc(tipX + dir * r * 0.55, tipY - r * 0.1, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTrunk(ctx, m) {
    if (!view.state) return;

    var shift = progress(view.shiftAt, SHIFT_MS);
    var slide = m.segH * (1 - easeOut(shift));
    var visible = Math.ceil(m.height / m.segH) + 2;
    var left = m.cx - m.trunkW / 2;

    for (var k = visible; k >= 0; k--) {
      var index = view.score + k;
      var segment = segmentAt(view.state, index);
      if (!segment) continue;

      var bottomY = m.groundY - k * m.segH + slide;
      if (bottomY < -m.segH) continue;

      if (segment.branch) {
        drawBranch(ctx, m.cx, bottomY, m, segment.branch);
      }

      ctx.fillStyle = COLORS.trunk;
      ctx.fillRect(left, bottomY - m.segH, m.trunkW, m.segH);

      // Светлая полоса по центру — ствол не выглядит плоским.
      ctx.fillStyle = COLORS.trunkHi;
      ctx.fillRect(left + m.trunkW * 0.34, bottomY - m.segH, m.trunkW * 0.2, m.segH);

      ctx.beginPath();
      ctx.rect(left, bottomY - m.segH, m.trunkW, m.segH);
      stroke(ctx, 3);
    }
  }

  function drawLumberjack(ctx, m) {
    var stunned = now() < view.stunUntil;
    var swing = 1 - progress(view.chopAt, CHOP_MS);
    var dir = view.side === "left" ? -1 : 1;

    var h = m.segH * 1.15;
    var w = h * 0.52;
    var footY = m.groundY + m.groundH * 0.34;
    var x = m.cx + dir * (m.trunkW * 0.5 + w * 0.6);

    ctx.save();
    ctx.translate(x, footY);
    // Фигура всегда повёрнута к стволу:влево и вправо отражаем зеркалом.
    ctx.scale(dir, 1);

    // Ноги
    ctx.fillStyle = COLORS.pants;
    roundRect(ctx, -w * 0.42, -h * 0.34, w * 0.34, h * 0.3, w * 0.08);
    ctx.fill();
    stroke(ctx, 2.5);
    roundRect(ctx, w * 0.06, -h * 0.34, w * 0.34, h * 0.3, w * 0.08);
    ctx.fill();
    stroke(ctx, 2.5);

    ctx.fillStyle = COLORS.boots;
    roundRect(ctx, -w * 0.48, -h * 0.08, w * 0.42, h * 0.1, w * 0.05);
    ctx.fill();
    stroke(ctx, 2.5);
    roundRect(ctx, w * 0.06, -h * 0.08, w * 0.42, h * 0.1, w * 0.05);
    ctx.fill();
    stroke(ctx, 2.5);

    // Туловище
    ctx.fillStyle = COLORS.shirt;
    roundRect(ctx, -w * 0.5, -h * 0.72, w, h * 0.42, w * 0.16);
    ctx.fill();
    stroke(ctx, 3);
    ctx.fillStyle = COLORS.shirtDark;
    ctx.fillRect(-w * 0.08, -h * 0.72, w * 0.16, h * 0.42);

    // Голова
    ctx.fillStyle = COLORS.skin;
    ctx.beginPath();
    ctx.arc(0, -h * 0.85, w * 0.32, 0, Math.PI * 2);
    ctx.fill();
    stroke(ctx, 3);

    ctx.fillStyle = COLORS.beard;
    ctx.beginPath();
    ctx.arc(0, -h * 0.78, w * 0.29, 0, Math.PI);
    ctx.fill();
    stroke(ctx, 2.5);

    ctx.fillStyle = COLORS.hat;
    ctx.beginPath();
    ctx.arc(0, -h * 0.92, w * 0.33, Math.PI, Math.PI * 2);
    ctx.fill();
    stroke(ctx, 2.5);
    ctx.fillStyle = COLORS.hatCuff;
    roundRect(ctx, -w * 0.35, -h * 0.95, w * 0.7, h * 0.07, w * 0.03);
    ctx.fill();
    stroke(ctx, 2.5);

    // Глаз: на оглушении — крестик.
    ctx.strokeStyle = COLORS.outline;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (stunned) {
      var e = w * 0.07;
      ctx.moveTo(-w * 0.12 - e, -h * 0.88 - e);
      ctx.lineTo(-w * 0.12 + e, -h * 0.88 + e);
      ctx.moveTo(-w * 0.12 + e, -h * 0.88 - e);
      ctx.lineTo(-w * 0.12 - e, -h * 0.88 + e);
    } else {
      ctx.moveTo(-w * 0.14, -h * 0.9);
      ctx.lineTo(-w * 0.14, -h * 0.85);
    }
    ctx.stroke();

    drawAxe(ctx, w, h, swing, stunned);

    ctx.restore();
  }

  /**
   * Топор рисуется поверх фигуры, иначе рукоять прячется за головой.
   * Угол 0 — рукоять вверх; положительный уводит топор от ствола (замах),
   * отрицательный опускает лезвие на ствол (удар).
   */
  function drawAxe(ctx, w, h, swing, stunned) {
    // Хват — на уровне пояса по центру корпуса: в покое топор уходит вверх
    // мимо головы, на ударе — горизонтально в ствол.
    var gripX = w * 0.02;
    var gripY = -h * 0.5;
    var angle = stunned ? 1.05 : 0.75 - swing * 2.15;
    var handleLen = h * 0.6;
    var handleW = w * 0.13;

    ctx.save();
    ctx.translate(gripX, gripY);
    ctx.rotate(angle);

    ctx.fillStyle = COLORS.axeHandle;
    roundRect(ctx, -handleW / 2, -handleLen, handleW, handleLen * 1.1, handleW * 0.4);
    ctx.fill();
    stroke(ctx, 2.5);

    // Голова: обух у рукояти, лезвие расходится наружу.
    var headH = h * 0.28;
    var headY = -handleLen - headH * 0.06;
    ctx.beginPath();
    ctx.moveTo(-handleW * 0.5, headY + headH * 0.66);
    ctx.lineTo(-handleW * 0.5, headY);
    ctx.lineTo(-w * 0.26, headY - headH * 0.12);
    ctx.quadraticCurveTo(-w * 0.5, headY + headH * 0.32, -w * 0.26, headY + headH * 0.78);
    ctx.closePath();
    ctx.fillStyle = COLORS.axeHead;
    ctx.fill();
    stroke(ctx, 2.5);

    ctx.restore();

    // Кисть на рукояти — без неё топор висит сам по себе.
    ctx.fillStyle = COLORS.skin;
    ctx.beginPath();
    ctx.arc(gripX, gripY, w * 0.13, 0, Math.PI * 2);
    ctx.fill();
    stroke(ctx, 2.5);
  }

  function drawChips(ctx) {
    var alive = [];

    for (var i = 0; i < view.chips.length; i++) {
      var chip = view.chips[i];
      var t = (now() - chip.born) / 1000;
      if (t > 0.9) continue;

      var x = chip.x + chip.vx * t;
      var y = chip.y + chip.vy * t + 900 * t * t * 0.5;

      ctx.globalAlpha = Math.max(0, 1 - t / 0.9);
      ctx.fillStyle = COLORS.chip;
      ctx.fillRect(x, y, chip.size, chip.size);
      ctx.globalAlpha = 1;
      alive.push(chip);
    }

    view.chips = alive;
  }

  /** Заметная индикация оглушения: красная рамка и полоса ожидания. */
  function drawStun(ctx, m) {
    var left = view.stunUntil - now();
    if (left <= 0) return;

    var total = view.state ? view.state.stunDurationMs : 1000;
    var pulse = 0.35 + 0.25 * Math.sin(now() / 70);

    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = COLORS.stun;
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, m.width - 14, m.height - 14);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = COLORS.stun;
    ctx.fillRect(0, 0, m.width, m.height);
    ctx.restore();

    var barW = clamp(m.width * 0.5, 140, 260);
    var barX = (m.width - barW) / 2;
    var barY = m.groundY + m.groundH * 0.5;

    ctx.fillStyle = "rgba(20,18,16,0.55)";
    roundRect(ctx, barX, barY, barW, 12, 6);
    ctx.fill();
    ctx.fillStyle = COLORS.stun;
    roundRect(ctx, barX, barY, (barW * left) / total, 12, 6);
    ctx.fill();
  }

  function findPlayer(id) {
    for (var i = 0; i < view.players.length; i++) {
      if (view.players[i].sessionId === id) return view.players[i];
    }
    return null;
  }

  function rivalId() {
    for (var i = 0; i < view.players.length; i++) {
      if (view.players[i].sessionId !== view.api.myId) return view.players[i].sessionId;
    }
    return null;
  }

  /** Счёт соперника сверху, свой — крупно под ним. */
  function drawHud(ctx, m) {
    if (!view.state) return;

    var target = view.state.targetScore;
    var rival = rivalId();
    var rivalPlayer = rival ? findPlayer(rival) : null;
    var rivalScore = rival && view.state.players[rival] ? view.state.players[rival].score : 0;

    var padTop = 10;
    var panelH = 46;
    var panelW = clamp(m.width - 24, 300, 420);
    var panelX = (m.width - panelW) / 2;

    ctx.fillStyle = "rgba(20,18,16,0.62)";
    roundRect(ctx, panelX, padTop, panelW, panelH, 12);
    ctx.fill();

    ctx.font = "600 14px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#dbe6f2";
    var name = rivalPlayer ? rivalPlayer.name : "Соперник";
    if (name.length > 12) name = name.slice(0, 11) + "…";
    ctx.fillText(name, panelX + 14, padTop + panelH / 2);

    ctx.textAlign = "right";
    ctx.font = "800 20px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(rivalScore + " / " + target, panelX + panelW - 14, padTop + panelH / 2);

    // Полоска прогресса соперника — видно, насколько он близко к победе.
    var trackW = panelW - 28;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(ctx, panelX + 14, padTop + panelH - 9, trackW, 5, 3);
    ctx.fill();
    ctx.fillStyle = COLORS.rival;
    roundRect(ctx, panelX + 14, padTop + panelH - 9, trackW * Math.min(1, rivalScore / target), 5, 3);
    ctx.fill();

    // Свой счёт.
    ctx.textAlign = "center";
    ctx.font = "800 " + Math.round(clamp(m.width * 0.14, 40, 64)) + "px system-ui, sans-serif";
    ctx.lineWidth = 6;
    ctx.strokeStyle = COLORS.outline;
    ctx.fillStyle = "#ffffff";
    var y = padTop + panelH + 44;
    ctx.strokeText(String(view.score), m.cx, y);
    ctx.fillText(String(view.score), m.cx, y);

    ctx.font = "600 13px system-ui, -apple-system, sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeText("из " + target, m.cx, y + 30);
    ctx.fillStyle = "#eef5ff";
    ctx.fillText("из " + target, m.cx, y + 30);
  }

  function drawGameOver(ctx, m) {
    if (!view.gameOver) return;
    ctx.fillStyle = "rgba(16,21,28,0.55)";
    ctx.fillRect(0, 0, m.width, m.height);
  }

  function frame() {
    if (!view) return;
    view.frame = window.requestAnimationFrame(frame);

    var ctx = view.ctx;
    var m = metrics();

    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, m.width, m.height);

    // Тряска от оглушения — самая заметная часть индикации.
    var shake = 1 - progress(view.shakeAt, SHAKE_MS);
    if (shake > 0) {
      var mag = 9 * shake;
      ctx.translate(Math.sin(now() / 18) * mag, Math.cos(now() / 13) * mag * 0.5);
    }

    drawSky(ctx, m);
    drawTrunk(ctx, m);
    drawGround(ctx, m);
    drawLumberjack(ctx, m);
    drawChips(ctx);

    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    drawStun(ctx, m);
    drawGameOver(ctx, m);
    drawHud(ctx, m);

    if (view.hint && (view.score > 0 || view.gameOver)) {
      view.hint.remove();
      view.hint = null;
    }
  }

  // --- контракт модуля ----------------------------------------------------

  window.Games.register({
    id: "treegame",

    mount: function (root, api) {
      injectStyles();
      view = createView(root, api);
      resize();
      bindInput();
      frame();
    },

    render: function (state, api) {
      if (!view || !state) return;
      reconcile(state, api);
    },

    unmount: function () {
      if (!view) return;
      window.cancelAnimationFrame(view.frame);
      view.canvas.removeEventListener("pointerdown", view.onPointer);
      window.removeEventListener("keydown", view.onKey);
      window.removeEventListener("resize", view.onResize);
      window.removeEventListener("orientationchange", view.onResize);
      view.canvas.remove();
      view = null;
    }
  });
})();
