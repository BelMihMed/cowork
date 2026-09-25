import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, extractCoreBlock, readSource } from "./helpers/extract-calculator.mjs";

// Цены и подбор тарифа Коворк/Код (T7, ТЗ §3.5–3.6). Регион «@cw:pricing» собранной страницы выполняется
// вместе с ядром (глоссарий, финмодель, методика) и моделью задач — проверяется реальный код.

const INDEX_FILE = new URL("../index.html", import.meta.url);
const source = readSource(INDEX_FILE);

function region(name) {
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.trim() === `// @cw:${name}`);
  const j = lines.findIndex((l, k) => k > i && l.trim() === "// @cw:end");
  assert.ok(i >= 0 && j > i, `регион @cw:${name} на месте`);
  return lines.slice(i + 1, j).join("\n");
}

const NAMES = ["COWORK_PRICE_CONFIG", "tierById", "periodByMonths", "thresholdsAreEstimate", "autoSeats", "recommendTier",
  "pricing", "resolveTariff", "subscriptionCost", "coworkEconomics", "tierWhy", "verdictText", "priceDateText",
  "applyPreset", "computeAll", "VAT"];

function load() {
  return evaluate(
    [extractCoreBlock(source, "glossary"), extractCoreBlock(source, "economics"), extractCoreBlock(source, "method"), region("model"), region("pricing")],
    NAMES
  );
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const close = (a, b, label, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${label}: ожидалось ${b}, получено ${a}`);
const COMPANY = { empSal: 100000, mgrSal: 100000, ropSal: 200000 };

test("config: dated, VAT from the core, tiers and periods as in COWORK-DATA.md", () => {
  const m = load();
  const cfg = m.COWORK_PRICE_CONFIG;
  assert.match(cfg.actualOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(cfg.actualOn)), "дата парсится");
  assert.equal(cfg.vat, m.VAT, "НДС берётся из глоссария ядра, не дублируется числом");
  assert.equal(cfg.vat, 0.22);
  assert.equal(cfg.vibeRub, 1, "1 вайб = 1 ₽ без НДС");
  assert.deepEqual(plain(cfg.tiers.map((t) => [t.id, t.name, t.vibes])), [["free", "Free", 0], ["pro", "Pro", 2000], ["max", "Max", 10000], ["ultra", "Ultra", 20000]]);
  assert.deepEqual(plain(cfg.tiers.map((t) => (t.maxRunsPerSeat === Infinity ? "inf" : t.maxRunsPerSeat))), [6, 100, 400, "inf"]);
  assert.ok(cfg.tiers.every((t) => t.color && t.note), "у каждого тарифа цвет и подпись объёма");
  assert.deepEqual(plain(cfg.periods.map((p) => [p.months, p.discount])), [[1, 0], [3, 0.05], [6, 0.1], [12, 0.2]]);
  assert.deepEqual(plain(cfg.codeRule), { minTierIfAny: "pro", minTierIfRegular: "max", regularRunsPerMonth: 2 });
  assert.equal(cfg.thresholdsStatus, "estimate", "пороги не подтверждены продуктом — подпись «ориентир»");
  assert.equal(m.thresholdsAreEstimate(), true);
  assert.match(m.priceDateText(), /Цены актуальны на 25 сентября 2026 г\. Пороги тарифов — ориентир/);
  assert.equal(m.priceDateText().includes(".."), false);
  assert.equal((source.match(/const COWORK_PRICE_CONFIG =/g) || []).length, 1, "единственный источник цен");
});

test("cost: vibes × vibeRub × (1 − discount) × (1 + VAT) × seats for every period", () => {
  const m = load();
  const gross = (tier, months, seats) => m.subscriptionCost(tier, months, seats).grossMonth;
  assert.equal(gross("pro", 1, 1), 2440);                 // 2000 × 1,22
  assert.equal(gross("pro", 3, 1), 2318);                 // × 0,95
  close(gross("pro", 6, 1), 2196, "pro 6 мес");           // × 0,90
  assert.equal(gross("pro", 12, 1), 1952);                // × 0,80
  assert.equal(gross("max", 6, 3), 32940);                // 10000 × 0,9 × 1,22 × 3
  assert.equal(gross("ultra", 3, 2), 46360);              // 20000 × 0,95 × 1,22 × 2
  assert.equal(gross("free", 12, 7), 0);
  const s = m.subscriptionCost("pro", 12, 2);
  assert.equal(s.vibesMonth, 3200, "вайбов в месяц со скидкой на все подписки");
  assert.equal(s.netMonth, 3200, "без НДС");
  assert.equal(s.grossYear, s.grossMonth * 12, "затраты первого года = подписка × 12");
  assert.equal(s.seats, 2);
  assert.equal(m.subscriptionCost("pro", 7, 1).period.months, 1, "неизвестный период → помесячно");
  assert.equal(m.subscriptionCost("nope", 1, 1).tier.id, "free", "неизвестный тариф → Free");
  assert.equal(m.subscriptionCost("pro", 1, 0).seats, 1, "подписок не меньше одной");
});

test("seats: default is the largest headcount among selected tasks, never below one", () => {
  const m = load();
  assert.equal(m.autoSeats(0), 1);
  assert.equal(m.autoSeats(2.4), 2);
  assert.equal(m.autoSeats(5), 5);
  assert.equal(m.autoSeats(undefined), 1);
});

test("recommendation: thresholds per seat, first tier that covers the load", () => {
  const m = load();
  const rec = (runs, seats = 1, codeRuns = 0) => m.recommendTier(runs, codeRuns, seats).tier.id;
  assert.equal(rec(0), "free");
  assert.equal(rec(6), "free");
  assert.equal(rec(6.01), "pro");
  assert.equal(rec(100), "pro");
  assert.equal(rec(100.01), "max");
  assert.equal(rec(400), "max");
  assert.equal(rec(401), "ultra");
  assert.equal(rec(100000), "ultra", "выше всех порогов — Ultra без лимита");
  assert.equal(rec(300, 5), "pro", "нагрузка делится на подписки: 60 на человека");
  assert.equal(rec(300, 0), "max", "ноль подписок считается как одна");
  const r = m.recommendTier(300, 0, 5);
  assert.equal(r.perSeat, 60);
  assert.equal(r.seats, 5);
  assert.equal(r.codeBump, null);
});

test("code rule: any Code task lifts to Pro, regular Code lifts to Max, never lowers", () => {
  const m = load();
  const r1 = m.recommendTier(3, 1, 1);           // 3 задачи на человека → Free, но есть Код
  assert.equal(r1.tier.id, "pro");
  assert.equal(r1.codeBump, "any");
  const r2 = m.recommendTier(3, 2, 1);           // ровно 2 запуска Кода — ещё не регулярно
  assert.equal(r2.tier.id, "pro");
  assert.equal(r2.codeBump, "any");
  const r3 = m.recommendTier(3, 2.01, 1);        // больше 2 — регулярно → Max
  assert.equal(r3.tier.id, "max");
  assert.equal(r3.codeBump, "regular");
  const r4 = m.recommendTier(150, 1, 1);         // нагрузка сама даёт Max — правило Кода планку не трогает
  assert.equal(r4.tier.id, "max");
  assert.equal(r4.codeBump, null);
  const r5 = m.recommendTier(500, 5, 1);         // Ultra по нагрузке, Код не понижает
  assert.equal(r5.tier.id, "ultra");
  assert.equal(r5.codeBump, null);
});

test("manual override: chosen tier stays, recommendation stays visible, reset returns to auto", () => {
  const m = load();
  m.applyPreset("team");
  const res = m.computeAll(COMPANY);
  let t = m.resolveTariff(res);
  assert.equal(t.rec.tier.id, "pro");
  assert.equal(t.chosen.id, "pro");
  assert.equal(t.seats, 5, "автоподбор подписок по максимуму c (план дня для 5 человек)");
  assert.equal(t.manual, false);
  assert.equal(t.months, 1);

  m.pricing.tierSel = "max";
  m.pricing.period = 12;
  t = m.resolveTariff(res);
  assert.equal(t.chosen.id, "max");
  assert.equal(t.rec.tier.id, "pro", "рекомендация не меняется от ручного выбора");
  assert.equal(t.manual, true);
  assert.equal(t.months, 12);
  assert.match(m.tierWhy(t.rec, t.chosen.id), /^Вы выбрали Max\. По вашим задачам подходит Pro: около 60 задач/);

  m.pricing.seatsManual = true; m.pricing.seats = 2;
  t = m.resolveTariff(res);
  assert.equal(t.seats, 2, "ручное число подписок не перетирается автоподбором");
  assert.equal(t.rec.perSeat, res.runs / 2, "нагрузка на подписку пересчитана");

  m.pricing.tierSel = null; m.pricing.seatsManual = false; m.pricing.period = 1;
  t = m.resolveTariff(res);
  assert.equal(t.chosen.id, "pro");
  assert.equal(t.seats, 5);
  assert.equal(t.manual, false);
  m.pricing.tierSel = "nope";
  assert.equal(m.resolveTariff(res).chosen.id, "pro", "неизвестный ручной тариф игнорируется");
});

test("texts: why-lines follow the source build, empty selection asks to pick tasks", () => {
  const m = load();
  assert.equal(m.tierWhy(m.recommendTier(0, 0, 1)), "Отметьте задачи, и калькулятор подскажет тариф.");
  assert.match(m.tierWhy(m.recommendTier(5, 0, 1)), /^Около 5 задач в месяц на человека\. Бесплатного тарифа хватит/);
  assert.match(m.tierWhy(m.recommendTier(44, 0, 1)), /^Около 44 задач .* ежедневная работа/);
  assert.match(m.tierWhy(m.recommendTier(200, 0, 1)), /плотный поток/);
  assert.match(m.tierWhy(m.recommendTier(900, 0, 1)), /^Больше 900 задач .* без остановки/);
  assert.match(m.tierWhy(m.recommendTier(3, 3, 1)), /уровень Max\.$/);
  assert.match(m.tierWhy(m.recommendTier(3, 1, 1)), /не ниже Pro\.$/);
});
