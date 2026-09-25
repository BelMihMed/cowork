import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, extractCoreBlock, readSource } from "./helpers/extract-calculator.mjs";

// Модель задач Коворк/Код (T6, ТЗ §3.2–3.4). Тесты читают собранный index.html: регион «@cw:model»
// (чистый JS без DOM) выполняется вместе с глоссарием и методикой ядра, поэтому проверяется реальный код.

const INDEX_FILE = new URL("../index.html", import.meta.url);
const source = readSource(INDEX_FILE);

function modelRegion(src) {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => l.trim() === "// @cw:model");
  const j = lines.findIndex((l, k) => k > i && l.trim() === "// @cw:end");
  assert.ok(i >= 0 && j > i, "регион модели @cw:model … @cw:end на месте");
  return lines.slice(i + 1, j).join("\n");
}

const NAMES = ["GROUPS", "ROLES", "PERIOD_MULT", "TASK_FIELDS", "TASKS", "REAL_COWORK", "realOf", "PRESETS", "DEFAULT_PRESET",
  "state", "initState", "applyPreset", "AUTOFILL", "taskRawHours", "taskRuns", "computeTask", "computeAll",
  "describeTask", "taskById", "fmtHours", "fmtMin"];

// свежая модель на каждый тест: состояние изолировано, ядро — из той же страницы
function loadModel(extraFragments = [], sandbox = {}) {
  return evaluate(
    [extractCoreBlock(source, "glossary"), extractCoreBlock(source, "method"), modelRegion(source), ...extraFragments],
    NAMES,
    sandbox
  );
}

const COMPANY = { empCount: 50, empSal: 100000, mgrCount: 5, mgrSal: 100000, ropCount: 1, ropSal: 200000 }; // дефолты блока компании

const plain = (v) => JSON.parse(JSON.stringify(v));   // значения из VM-контекста — другой realm, deepEqual сравнивает как plain JSON
const close = (a, b, label, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${label}: ожидалось ${b}, получено ${a}`);

// типовые значения из COWORK-DATA.md §2 (стартовые, статус «ориентир»)
const SHEET = [
  ["rep", "boss", "boss", 240, 8, 1, "week", 1, false, false],
  ["plan", "boss", "boss", 30, 2, 1, "day", 1, false, false],
  ["load", "boss", "boss", 120, 5, 1, "week", 1, false, false],
  ["risk", "boss", "boss", 60, 5, 1, "week", 1, false, true],
  ["chat", "boss", "boss", 60, 5, 2, "week", 1, false, true],
  ["call", "sales", "sales", 15, 1, 2, "day", 1, false, false],
  ["kp", "sales", "sales", 240, 5, 1, "week", 1, false, false],
  ["meet", "sales", "sales", 30, 3, 3, "week", 1, false, false],
  ["sales", "sales", "sales", 180, 7, 1, "month", 1, false, false],
  ["mail", "sales", "sales", 60, 5, 1, "week", 1, false, true],
  ["crm", "sales", "sales", 240, 10, 1, "month", 1, false, true],
  ["dash", "mkt", "emp", 360, 10, 1, "month", 1, true, false],
  ["comp", "mkt", "emp", 360, 10, 1, "quarter", 1, false, false],
  ["diff", "mkt", "emp", 120, 6, 2, "month", 1, false, false],
  ["land", "mkt", "emp", 1440, 20, 1, "quarter", 1, true, false]
];
const REAL_SHEET = { rep: 0.55, plan: 0.35, load: 0.5, risk: 0.5, chat: 0.4, call: 0.3, kp: 0.55, meet: 0.4, sales: 0.55, mail: 0.45, crm: 0.55, dash: 0.6, comp: 0.6, diff: 0.45, land: 0.7 };

test("tasks: 15 tasks match the product data sheet, ids unique, groups and roles valid", () => {
  const m = loadModel();
  assert.equal(m.TASKS.length, 15);
  assert.equal(new Set(m.TASKS.map((t) => t.id)).size, 15, "id уникальны");
  const groups = plain(m.GROUPS.map((g) => g.id));
  assert.deepEqual(groups, ["boss", "sales", "mkt"]);
  SHEET.forEach(([id, group, role, b, a, f, u, c, code, est]) => {
    const t = m.taskById(id);
    assert.ok(t, `задача ${id} есть`);
    assert.deepEqual(plain([t.group, t.role, t.b, t.a, t.f, t.u, t.c, t.code, t.est]), [group, role, b, a, f, u, c, code, est], `типовые значения ${id}`);
    assert.ok(t.n && t.p && t.q, `у ${id} есть название, боль и промпт`);
    assert.ok(groups.includes(t.group) && m.ROLES[t.role], `группа и роль ${id} известны`);
    assert.ok(!("demo" in t), "флаг demo из сборки удалён");
  });
  assert.deepEqual(plain(Object.keys(m.PERIOD_MULT)), ["day", "week", "month", "quarter"]);
});

test("formulas: month hours use the shared period multipliers, never own 21 / 165 / 1.3", () => {
  const m = loadModel();
  const hoursFor = (u) => m.taskRawHours({ b: 60, a: 0, f: 1, u, c: 1 });
  assert.equal(hoursFor("day"), 22, "день → DAYS_MONTH = 22");
  close(hoursFor("week"), 52 / 12, "неделя → WEEKS_MONTH");
  assert.equal(hoursFor("month"), 1);
  close(hoursFor("quarter"), 1 / 3, "квартал → 1/3");
  assert.equal(hoursFor("year"), 0, "неизвестная единица не считается");
  assert.equal(m.taskRawHours({ b: 10, a: 30, f: 1, u: "day", c: 1 }), 0, "если с Коворком дольше — экономии нет, отрицательных часов нет");
  assert.equal(m.taskRawHours({ b: 60, a: 0, f: 2, u: "week", c: 3 }), 60 / 60 * 2 * (52 / 12) * 3);
  assert.equal(m.taskRuns({ f: 2, u: "day", c: 3 }), 132, "задач в месяц = f × 22 × c");
  const region = modelRegion(source);
  for (const stale of ["165", "1.3", "/21", "* 21", "*21"]) {
    assert.equal(region.includes(stale), false, `в модели нет собственной константы ${stale}`);
  }
});

test("realization: coefficient from REAL_COWORK is applied exactly once and raw hours are kept", () => {
  const m = loadModel();
  m.TASKS.forEach((t) => {
    const c = m.REAL_COWORK[t.id];
    assert.ok(c && c.k > 0 && c.k <= 1 && c.why.length > 40, `у ${t.id} есть коэффициент и обоснование`);
    assert.equal(c.k, REAL_SHEET[t.id], `k ${t.id} как в ТЗ §3.4`);
    assert.equal(m.realOf(t), c.k, "realOf берёт коэффициент из конфига через realCoef ядра");
  });
  assert.equal(m.realOf({ id: "nope" }), 1, "без записи дисконта нет");
  const rep = m.taskById("rep");
  const r = m.computeTask(rep, m.state.rep, COMPANY);
  close(r.rawHours, 16.755556, "rep: (240−8)/60 × 1 × 52/12 × 1", 0.0001);
  close(r.hours, r.rawHours * 0.55, "часы = сырые × k", 0.0001);
  close(r.fot, r.hours * r.rate, "деньги = часы × ставка", 0.0001);
  close(r.rate, 1590.909091, "ставка руководителя = 200 000 × 1,4 ÷ 176", 0.0001);
  close(r.fot, 14661.111111, "rep на дефолтной компании", 0.001);
  assert.equal(r.real, 0.55);
  close(r.runs, 52 / 12, "запусков в месяц", 0.0001);
});

test("roles: hourly rate comes from the company salary of the task's role", () => {
  const m = loadModel();
  const rate = (id, company) => m.computeTask(m.taskById(id), m.state[id], company).rate;
  close(rate("rep", { ropSal: 200000 }), 1590.909091, "boss → ropSal", 0.0001);
  close(rate("call", { mgrSal: 100000 }), 795.454545, "sales → mgrSal", 0.0001);
  close(rate("dash", { empSal: 88000 }), 700, "emp (маркетинг) → empSal", 0.0001);
  assert.equal(rate("rep", { mgrSal: 100000 }), 0, "чужой оклад не подставляется");
  const noSalary = m.computeTask(m.taskById("rep"), m.state.rep, {});
  assert.ok(noSalary.hours > 0 && noSalary.fot === 0, "без оклада часы есть, денег нет");
  // маппинг ролей на ключи блока компании стабилен ради аналитики
  assert.deepEqual(plain(Object.fromEntries(Object.entries(m.ROLES).map(([k, v]) => [k, [v.sal, v.cnt]]))),
    { boss: ["ropSal", "ropCount"], sales: ["mgrSal", "mgrCount"], emp: ["empSal", null] });
});

test("autofill: role headcount fills the people field, the whole-company count never does", () => {
  const m = loadModel();
  assert.deepEqual(plain(Object.keys(m.AUTOFILL).sort()), ["mgrCount", "ropCount"]);
  assert.deepEqual(plain(m.AUTOFILL.ropCount.map(([id, k]) => `${id}.${k}`)), ["rep.c", "plan.c", "load.c", "risk.c", "chat.c"]);
  assert.deepEqual(plain(m.AUTOFILL.mgrCount.map(([id]) => id)), ["call", "kp", "meet", "sales", "mail", "crm"]);
  assert.equal("empCount" in m.AUTOFILL, false, "empCount — вся компания, маркетингу не подставляется");
});

test("dirty: a hand-edited people field survives both preset and company autofill", () => {
  // прогоняем настоящий applyCompany ядра (блок company) с заглушкой document
  const targets = {};
  const sandbox = { document: { querySelectorAll: () => [], querySelector: (sel) => targets[sel] || null } };
  const m = loadModel([extractCoreBlock(source, "company")], sandbox);
  m.state.call.values.c = 7; m.state.call.dirty.c = true;   // руками: 7 человек готовятся к звонкам
  m.applyPreset("team");
  assert.equal(m.state.call.values.c, 7, "пресет не трогает ручное значение");
  assert.equal(m.state.kp.values.c, 3, "а множители пресета для остальных применяет");
  assert.equal(m.state.rep.values.c, 1);
});

test("dirty: core applyCompany respects dirty flags of the product state", () => {
  const targets = { '#card-kp .num-in[data-k="c"]': { value: "old" } };
  const sandbox = { document: { querySelectorAll: () => [], querySelector: (sel) => targets[sel] || null } };
  const src = [extractCoreBlock(source, "glossary"), extractCoreBlock(source, "method"), modelRegion(source), extractCoreBlock(source, "company")];
  const m = evaluate(src, [...NAMES, "applyCompany"], sandbox);
  m.state.call.values.c = 7; m.state.call.dirty.c = true;
  m.applyCompany({ value: "9", dataset: { comp: "mgrCount" } });
  assert.equal(m.state.call.values.c, 7, "ручное поле не перетёрто автозаполнением");
  assert.equal(m.state.kp.values.c, 9, "остальные задачи роли получили счётчик");
  assert.equal(targets['#card-kp .num-in[data-k="c"]'].value, "9", "и поле на карточке обновлено");
  assert.equal(m.state.dash.values.c, 1, "маркетинг счётчиком компании не заполняется");
  m.applyCompany({ value: "4", dataset: { comp: "ropCount" } });
  assert.equal(m.state.rep.values.c, 4);
});

test("presets: sets of tasks and multipliers from the source build", () => {
  const m = loadModel();
  assert.equal(m.DEFAULT_PRESET, "boss");
  assert.deepEqual(plain(Object.keys(m.PRESETS)), ["boss", "sales", "mkt", "team"]);
  const selected = () => plain(m.TASKS.filter((t) => m.state[t.id].selected).map((t) => t.id));
  assert.equal(m.applyPreset("boss"), true);
  assert.deepEqual(selected(), ["rep", "plan", "load", "risk", "chat"]);
  m.applyPreset("sales");
  assert.deepEqual(selected(), ["plan", "call", "kp", "meet", "mail"]);
  m.applyPreset("mkt");
  assert.deepEqual(selected(), ["plan", "dash", "comp", "diff", "land"]);
  m.state.plan.values.b = 45;   // не dirty — пресет вернёт типовое значение
  m.applyPreset("team");
  assert.deepEqual(selected(), ["rep", "plan", "call", "kp", "meet", "sales", "dash"]);
  assert.deepEqual(plain([m.state.plan.values.c, m.state.call.values.c, m.state.kp.values.c, m.state.meet.values.c, m.state.rep.values.c]), [5, 3, 3, 3, 1]);
  assert.equal(m.state.plan.values.b, 30, "поля возвращаются к типовым");
  assert.equal(m.applyPreset("nope"), false);
  m.initState();
  assert.deepEqual(selected(), [], "initState сбрасывает выбор");
});

test("totals: four presets on the default company give the frozen reference numbers", () => {
  const m = loadModel();
  const expected = {
    boss:  { n: 5, rawH: 47.2444,  h: 22.1256, fot: 35199.75, runs: 43.6667,  codeRuns: 0,      maxC: 1 },
    sales: { n: 5, rawH: 47.3278,  h: 20.1356, fot: 18875.25, runs: 87.6667,  codeRuns: 0,      maxC: 1 },
    mkt:   { n: 5, rawH: 29.7333,  h: 15.4922, fot: 15181.69, runs: 25.6667,  codeRuns: 1.3333, maxC: 1 },
    team:  { n: 7, rawH: 176.0722, h: 76.5322, fot: 82500.13, runs: 300.3333, codeRuns: 1,      maxC: 5 }
  };
  for (const [preset, e] of Object.entries(expected)) {
    m.applyPreset(preset);
    const r = m.computeAll(COMPANY);
    assert.equal(r.items.length, e.n, `${preset}: задач`);
    close(r.totalRawHours, e.rawH, `${preset}: сырые часы`);
    close(r.totalHours, e.h, `${preset}: часы с коэффициентом`);
    close(r.totalFot, e.fot, `${preset}: стоимость времени`);
    close(r.runs, e.runs, `${preset}: задач в месяц`);
    close(r.codeRuns, e.codeRuns, `${preset}: запусков Кода`);
    assert.equal(r.maxC, e.maxC, `${preset}: максимум людей`);
    close(r.fte, r.totalHours / 176, `${preset}: FTE = часы / HOURS_MONTH`, 0.0001);
    close(r.days, r.totalHours / 8, `${preset}: дни = часы / DAY_HOURS`, 0.0001);
    assert.ok(r.totalHours < r.totalRawHours, "коэффициент уменьшает часы");
  }
});

test("explanations and formatting: describeTask names the numbers a reader can check", () => {
  const m = loadModel();
  m.applyPreset("boss");
  const text = m.describeTask(m.taskById("rep"), m.state.rep, COMPANY);
  for (const part of ["240 мин", "8 мин", "232 мин", "1 в неделю", "17 ч", "55%", "9,2 ч", "1 591 ₽", "14 661 ₽"]) {
    assert.ok(text.replace(/ /g, " ").includes(part), `пояснение содержит ${part}`);
  }
  assert.equal(m.fmtHours(22.1256), "22 ч");
  assert.equal(m.fmtHours(3.593), "3,6 ч");
  assert.equal(m.fmtMin(240), "4 ч");
  assert.equal(m.fmtMin(90), "1,5 ч");
  assert.equal(m.fmtMin(15), "15 мин");
  assert.equal(m.fmtMin(1440), "3 дн.");
});
