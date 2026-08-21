import test from "node:test";
import assert from "node:assert/strict";

import { treegame, type TreeGameState } from "./index";
import { treegameConfig } from "./config";
import { buildTrunk, type BranchSide, type TrunkSegment } from "./trunk";
import type { GamePlayer } from "../types";

const PLAYERS: GamePlayer[] = [
  { id: "p1", name: "Аня" },
  { id: "p2", name: "Боря" },
];

const chop = (side: BranchSide) => ({ type: "chop" as const, side });

function newState(): TreeGameState {
  return treegame.createState(PLAYERS);
}

/** Ставит игрока на сегмент, где ветка с нужной стороны (или без ветки). */
function scoreWithBranch(state: TreeGameState, branch: BranchSide | null): number {
  const segment = state.trunk.find((s) => s.branch === branch);
  assert.ok(segment, `в стволе не нашлось сегмента с веткой ${branch}`);
  return segment.index;
}

// --- генерация ствола ----------------------------------------------------

test("один сид даёт один и тот же ствол", () => {
  const a = buildTrunk(123456, 200);
  const b = buildTrunk(123456, 200);
  assert.deepEqual(a, b);
});

test("разные сиды дают разные стволы", () => {
  const a = buildTrunk(1, 200);
  const b = buildTrunk(2, 200);
  assert.notDeepEqual(a, b);
});

test("догенерированный участок совпадает с генерацией всего ствола сразу", () => {
  const whole = buildTrunk(987654, 200);

  // Растим порциями, как это делает партия по ходу игры.
  for (const count of [50, 100, 150, 200]) {
    const partial = buildTrunk(987654, count);
    assert.deepEqual(
      partial,
      whole.slice(0, count),
      `участок из ${count} сегментов разошёлся с целым стволом`
    );
  }
});

test("первые сегменты — без веток", () => {
  for (let seed = 0; seed < 50; seed++) {
    const trunk = buildTrunk(seed, 60);
    for (let i = 0; i < treegameConfig.safeStart; i++) {
      assert.equal(trunk[i].branch, null, `сид ${seed}: ветка на сегменте ${i}`);
    }
  }
});

test("не бывает четырёх веток подряд с одной стороны", () => {
  const maxRun = treegameConfig.maxSameRun;

  for (let seed = 0; seed < 300; seed++) {
    const trunk = buildTrunk(seed, 400);

    let run = 0;
    let side: BranchSide | null = null;

    for (const segment of trunk) {
      if (segment.branch !== null && segment.branch === side) {
        run++;
      } else {
        side = segment.branch;
        run = segment.branch === null ? 0 : 1;
      }

      assert.ok(
        run <= maxRun,
        `сид ${seed}: ${run} веток подряд с одной стороны на сегменте ${segment.index}`
      );
    }
  }
});

test("ветки вообще генерируются, и обе стороны встречаются", () => {
  const trunk = buildTrunk(42, 400);
  const left = trunk.filter((s) => s.branch === "left").length;
  const right = trunk.filter((s) => s.branch === "right").length;

  assert.ok(left > 20, `слева всего ${left} веток`);
  assert.ok(right > 20, `справа всего ${right} веток`);
});

test("индексы сегментов идут подряд", () => {
  const trunk = buildTrunk(7, 120);
  trunk.forEach((segment, i) => assert.equal(segment.index, i));
});

// --- состояние партии ----------------------------------------------------

test("createState заводит обоих игроков и участок ствола", () => {
  const state = newState();

  assert.deepEqual(Object.keys(state.players).sort(), ["p1", "p2"]);
  assert.deepEqual(state.players.p1, { score: 0, stunnedUntil: 0 });
  assert.equal(state.targetScore, treegameConfig.targetScore);
  assert.equal(state.stunDurationMs, treegameConfig.stunDurationMs);
  assert.ok(state.trunk.length >= treegameConfig.chunkSize);
  assert.equal(state.trunk[0].index, 0);
});

test("сид у двух партий разный", () => {
  const seeds = new Set(Array.from({ length: 20 }, () => newState().seed));
  assert.ok(seeds.size > 1, "сид не меняется от партии к партии");
});

// --- валидация -----------------------------------------------------------

test("чужие и кривые намерения отклоняются", () => {
  const state = newState();

  assert.equal(treegame.validateAction(state, "p1", { type: "chop", side: "left" }), true);
  assert.equal(treegame.validateAction(state, "p1", { type: "teleport", side: "left" }), false);
  assert.equal(treegame.validateAction(state, "p1", { type: "chop", side: "вверх" }), false);
  assert.equal(treegame.validateAction(state, "p1", { type: "chop" }), false);
  assert.equal(treegame.validateAction(state, "чужой", chop("left")), false);
});

test("оглушённый игрок рубить не может", () => {
  const state = newState();
  const stunned: TreeGameState = {
    ...state,
    players: {
      ...state.players,
      p1: { score: 0, stunnedUntil: Date.now() + 5000 },
    },
  };

  assert.equal(treegame.validateAction(stunned, "p1", chop("left")), false);
  // Соперника чужое оглушение не касается.
  assert.equal(treegame.validateAction(stunned, "p2", chop("left")), true);
});

test("когда оглушение прошло, рубить снова можно", () => {
  const state = newState();
  const recovered: TreeGameState = {
    ...state,
    players: { ...state.players, p1: { score: 0, stunnedUntil: Date.now() - 1 } },
  };

  assert.equal(treegame.validateAction(recovered, "p1", chop("left")), true);
});

test("после победы удары не принимаются", () => {
  const state = newState();
  const finished: TreeGameState = {
    ...state,
    players: { ...state.players, p1: { score: state.targetScore, stunnedUntil: 0 } },
  };

  assert.equal(treegame.validateAction(finished, "p1", chop("left")), false);
  assert.equal(treegame.validateAction(finished, "p2", chop("left")), false);
});

// --- удары ---------------------------------------------------------------

test("чистый удар поднимает счёт и не глушит", () => {
  const state = newState();
  const clean = scoreWithBranch(state, null);
  const before: TreeGameState = {
    ...state,
    players: { ...state.players, p1: { score: clean, stunnedUntil: 0 } },
  };

  const after = treegame.applyAction(before, "p1", chop("left"));

  assert.equal(after.players.p1.score, clean + 1);
  assert.equal(after.players.p1.stunnedUntil, 0);
});

test("удар со стороны ветки глушит и не даёт очка", () => {
  const state = newState();
  const index = scoreWithBranch(state, "left");
  const before: TreeGameState = {
    ...state,
    players: { ...state.players, p1: { score: index, stunnedUntil: 0 } },
  };

  const at = Date.now();
  const after = treegame.applyAction(before, "p1", chop("left"));

  assert.equal(after.players.p1.score, index, "счёт вырос, хотя удар пришёлся в ветку");
  assert.ok(
    after.players.p1.stunnedUntil >= at + state.stunDurationMs,
    "оглушение не начислено"
  );
  assert.ok(after.players.p1.stunnedUntil <= Date.now() + state.stunDurationMs);
});

test("удар с чистой стороны того же сегмента проходит", () => {
  const state = newState();
  const index = scoreWithBranch(state, "left");
  const before: TreeGameState = {
    ...state,
    players: { ...state.players, p1: { score: index, stunnedUntil: 0 } },
  };

  const after = treegame.applyAction(before, "p1", chop("right"));

  assert.equal(after.players.p1.score, index + 1);
  assert.equal(after.players.p1.stunnedUntil, 0);
});

test("удар одного игрока не трогает другого", () => {
  const state = newState();
  const after = treegame.applyAction(state, "p1", chop("left"));

  assert.deepEqual(after.players.p2, state.players.p2);
  assert.deepEqual(state.players.p1, { score: 0, stunnedUntil: 0 }, "исходное состояние изменено");
});

// --- ствол по ходу партии ------------------------------------------------

test("ствол догенерируется, когда игрок подходит к концу участка", () => {
  let state = newState();
  const generatedAtStart = state.trunk[state.trunk.length - 1].index + 1;

  // Прогоняем одного игрока далеко вперёд чистыми ударами.
  const target = generatedAtStart + 20;
  while (state.players.p1.score < target) {
    const score = state.players.p1.score;
    const segment = state.trunk[score - state.trunk[0].index];
    assert.ok(segment, `сегмент ${score} не сгенерирован`);

    const side: BranchSide = segment.branch === "left" ? "right" : "left";
    state = treegame.applyAction(state, "p1", chop(side));
  }

  const generatedNow = state.trunk[state.trunk.length - 1].index + 1;
  assert.ok(generatedNow > generatedAtStart, "ствол не вырос");
  assert.ok(
    generatedNow >= state.players.p1.score + treegameConfig.lookahead,
    "перед игроком не осталось запаса"
  );
});

test("срубленное низовье выбрасывается, но сегмент отстающего остаётся", () => {
  let state = newState();

  for (let i = 0; i < 30; i++) {
    const score = state.players.p1.score;
    const segment = state.trunk[score - state.trunk[0].index];
    const side: BranchSide = segment.branch === "left" ? "right" : "left";
    state = treegame.applyAction(state, "p1", chop(side));
  }

  // p2 не рубил ни разу — ствол обрезан по нему, а не по лидеру.
  assert.equal(state.players.p2.score, 0);
  assert.equal(state.trunk[0].index, 0);

  // Теперь двигаем отстающего и смотрим, что низовье ушло.
  for (let i = 0; i < 10; i++) {
    const score = state.players.p2.score;
    const segment = state.trunk[score - state.trunk[0].index];
    const side: BranchSide = segment.branch === "left" ? "right" : "left";
    state = treegame.applyAction(state, "p2", chop(side));
  }

  assert.equal(state.trunk[0].index, state.players.p2.score);
  assert.ok(
    state.trunk.length < 100,
    `окно ствола разрослось до ${state.trunk.length} сегментов`
  );
});

test("сегменты в окне не меняются от обрезки", () => {
  const reference = buildTrunk(0, 200);
  let state: TreeGameState = { ...newState(), seed: 0, trunk: buildTrunk(0, 50) };

  for (let i = 0; i < 40; i++) {
    const score = state.players.p1.score;
    const segment = state.trunk[score - state.trunk[0].index];
    const side: BranchSide = segment.branch === "left" ? "right" : "left";
    state = treegame.applyAction(state, "p1", chop(side));
  }

  for (const segment of state.trunk) {
    assert.deepEqual(
      segment,
      reference[segment.index],
      `сегмент ${segment.index} разошёлся с эталонным стволом`
    );
  }
});

// --- конец партии --------------------------------------------------------

test("партия кончается на целевом счёте", () => {
  const state = newState();
  assert.equal(treegame.checkGameOver(state), null);

  const won: TreeGameState = {
    ...state,
    players: { ...state.players, p2: { score: state.targetScore, stunnedUntil: 0 } },
  };

  assert.deepEqual(treegame.checkGameOver(won), { winnerId: "p2", reason: "target" });
});

test("на счёте меньше целевого партия продолжается", () => {
  const state = newState();
  const almost: TreeGameState = {
    ...state,
    players: { ...state.players, p1: { score: state.targetScore - 1, stunnedUntil: 0 } },
  };

  assert.equal(treegame.checkGameOver(almost), null);
});

// --- партия целиком ------------------------------------------------------

test("партия доигрывается до победы через ветки и оглушения", () => {
  let state = newState();
  let stuns = 0;

  // Игрок сначала всегда пробует слева — на левых ветках он за это получает
  // оглушение, после чего обходит сегмент справа. Так в партии встречаются
  // оба исхода удара.
  for (let step = 0; step < 500 && treegame.checkGameOver(state) === null; step++) {
    assert.equal(
      treegame.validateAction(state, "p1", chop("left")),
      true,
      `ход отклонён на шаге ${step}`
    );

    const before = state.players.p1.score;
    state = treegame.applyAction(state, "p1", chop("left"));

    if (state.players.p1.score > before) continue;

    // Попали в ветку: пока оглушены — рубить нельзя.
    stuns++;
    assert.equal(
      treegame.validateAction(state, "p1", chop("right")),
      false,
      "оглушение не мешает бить"
    );

    // Отматываем оглушение вместо реального ожидания и обходим ветку.
    state = {
      ...state,
      players: {
        ...state.players,
        p1: { score: state.players.p1.score, stunnedUntil: Date.now() - 1 },
      },
    };

    state = treegame.applyAction(state, "p1", chop("right"));
    assert.equal(
      state.players.p1.score,
      before + 1,
      "обход ветки с чистой стороны не сработал"
    );
  }

  assert.deepEqual(treegame.checkGameOver(state), { winnerId: "p1", reason: "target" });
  assert.ok(stuns > 0, "ни одного оглушения за партию — ветки не встречались");
});
