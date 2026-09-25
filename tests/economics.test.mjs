import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, extractCoreBlock, readSource } from "./helpers/extract-calculator.mjs";

// Финмодель Коворк/Код (T7, ТЗ §3.7): та же calculateEconomics ядра, что у BitrixGPT, плюс окупаемость в рабочих днях.

const INDEX_FILE = new URL("../index.html", import.meta.url);
const source = readSource(INDEX_FILE);

function region(name) {
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.trim() === `// @cw:${name}`);
  const j = lines.findIndex((l, k) => k > i && l.trim() === "// @cw:end");
  return lines.slice(i + 1, j).join("\n");
}
const load = () => evaluate(
  [extractCoreBlock(source, "glossary"), extractCoreBlock(source, "economics"), extractCoreBlock(source, "method"), region("model"), region("pricing")],
  ["calculateEconomics", "subscriptionCost", "coworkEconomics", "verdictText", "applyPreset", "computeAll", "resolveTariff", "DAYS_MONTH"]
);
const plain = (v) => JSON.parse(JSON.stringify(v));
const close = (a, b, label, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${label}: ожидалось ${b}, получено ${a}`);
const COMPANY = { empSal: 100000, mgrSal: 100000, ropSal: 200000 };

test("shared rule: calculateEconomics gives the BitrixGPT values on the same inputs", () => {
  const m = load();
  // эталон из tests/formulas.test.mjs репозитория bitrixgpt-calc
  assert.deepEqual(plain(m.calculateEconomics(100000, 200000)), {
    fotMonth: 100000, fotYear: 1200000, firstYearCosts: 200000, netFirstYear: 1000000,
    paybackMonths: 2, costSharePercent: 16.666666666666664
  });
  const noFot = plain(m.calculateEconomics(0, 9600));
  assert.equal(noFot.netFirstYear, -9600);
  assert.equal(noFot.paybackMonths, 0);
});

test("cowork economics: subscription × 12 is the first-year cost, payback in working days", () => {
  const m = load();
  const sub = m.subscriptionCost("pro", 1, 1);             // 2 440 ₽ в месяц с НДС
  const e = m.coworkEconomics(35199.75, sub);
  assert.equal(e.fotMonth, 35199.75);
  assert.equal(e.fotYear, 35199.75 * 12);
  assert.equal(e.firstYearCosts, 2440 * 12);
  assert.equal(e.subscriptionMonth, 2440);
  assert.equal(e.subscriptionYear, 29280);
  close(e.netFirstYear, 35199.75 * 12 - 29280, "чистая экономия первого года");
  close(e.netMonth, 35199.75 - 2440, "чистая экономия в месяц");
  close(e.costSharePercent, 29280 / (35199.75 * 12) * 100, "доля затрат в экономии", 1e-9);
  assert.equal(e.paybackDays, Math.ceil(2440 / (35199.75 / m.DAYS_MONTH)), "окупаемость = ceil(подписка / (ФОТ / DAYS_MONTH))");
  assert.equal(e.paybackDays, 2);
  close(e.ratio, 35199.75 / 2440, "во сколько раз экономия больше подписки", 1e-9);
  assert.equal(plain(m.coworkEconomics(35199.75, sub)).paybackMonths, m.calculateEconomics(35199.75, 29280).paybackMonths, "поля ядра пробрасываются как есть");
});

test("edge cases: negative result, free tier, zero savings", () => {
  const m = load();
  const neg = m.coworkEconomics(1000, m.subscriptionCost("max", 1, 1));   // 12 200 ₽ подписки против 1 000 ₽ экономии
  assert.ok(neg.netMonth < 0 && neg.netFirstYear < 0, "отрицательный результат не маскируется");
  assert.equal(neg.netFirstYear, 1000 * 12 - 12200 * 12);
  assert.equal(neg.paybackDays, Math.ceil(12200 / (1000 / 22)), "окупаемость дольше месяца показывается честно, в днях");
  assert.match(m.verdictText({ items: [1] }, neg), /^Пока экономия меньше подписки/);

  const free = m.coworkEconomics(5000, m.subscriptionCost("free", 12, 3));
  assert.equal(free.subscriptionYear, 0);
  assert.equal(free.paybackDays, 0);
  assert.equal(free.ratio, Infinity);
  assert.equal(free.netFirstYear, 60000);
  assert.match(m.verdictText({ items: [1] }, free), /^На бесплатном тарифе вся экономия ваша/);

  const zero = m.coworkEconomics(0, m.subscriptionCost("pro", 1, 1));
  assert.equal(zero.paybackDays, 0);
  assert.equal(zero.ratio, 0);
  assert.equal(zero.netFirstYear, -29280);
  assert.equal(m.verdictText({ items: [] }, zero), "Отметьте задачи, которые делаете руками.");
});

test("end to end: default company, every preset lands on Pro with a positive first year", () => {
  const m = load();
  const expected = {
    boss:  { seats: 1, grossMonth: 2440,  netMonth: 32759.75, netYear: 393116.97, payback: 2, ratio: 14.4 },
    sales: { seats: 1, grossMonth: 2440,  netMonth: 16435.25, netYear: 197223.03, payback: 3, ratio: 7.7 },
    mkt:   { seats: 1, grossMonth: 2440,  netMonth: 12741.69, netYear: 152900.30, payback: 4, ratio: 6.2 },
    team:  { seats: 5, grossMonth: 12200, netMonth: 70300.13, netYear: 843601.52, payback: 4, ratio: 6.8 }
  };
  for (const [preset, e] of Object.entries(expected)) {
    m.applyPreset(preset);
    const res = m.computeAll(COMPANY);
    const t = m.resolveTariff(res);
    const sub = m.subscriptionCost(t.chosen.id, t.months, t.seats);
    const econ = m.coworkEconomics(res.totalFot, sub);
    assert.equal(t.rec.tier.id, "pro", `${preset}: рекомендация`);
    assert.equal(t.seats, e.seats, `${preset}: подписок`);
    assert.equal(sub.grossMonth, e.grossMonth, `${preset}: подписка в месяц с НДС`);
    close(econ.netMonth, e.netMonth, `${preset}: чистая экономия в месяц`);
    close(econ.netFirstYear, e.netYear, `${preset}: чистая экономия первого года`);
    assert.equal(econ.paybackDays, e.payback, `${preset}: окупаемость, раб. дн.`);
    close(Math.round(econ.ratio * 10) / 10, e.ratio, `${preset}: кратность`, 0.001);
    assert.match(m.verdictText(res, econ), new RegExp(`окупается за первые ${e.payback} раб\\. дн\\.`));
  }
});
