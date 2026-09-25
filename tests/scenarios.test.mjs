import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, extractCoreBlock, readSource } from "./helpers/extract-calculator.mjs";

// Сквозные прогоны (T15, ТЗ §9): четыре пресета «Кто вы?» на дефолтной компании проходят всю цепочку страницы —
// задачи → часы с коэффициентом → подписки и тариф → стоимость → финмодель → текст для копирования → PDF → записи аналитики.
// Эталоны зафиксированы при приёмке; изменение любого числа здесь — осознанное решение о модели или ценах.

const INDEX_FILE = new URL("../index.html", import.meta.url);
const source = readSource(INDEX_FILE);

function region(name) {
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.trim() === `// @cw:${name}`);
  const j = lines.findIndex((l, k) => k > i && l.trim() === "// @cw:end");
  assert.ok(i >= 0 && j > i, `регион @cw:${name} на месте`);
  return lines.slice(i + 1, j).join("\n");
}
const NAMES = ["applyPreset", "computeAll", "resolveTariff", "subscriptionCost", "coworkEconomics", "buildSummaryText",
  "buildCoworkReportHtml", "buildCoworkReportRecord", "buildCopyRecord", "coworkSessionFields", "pricing", "state", "TASKS",
  "CTA_COWORK_SELF", "CTA_COWORK_HELP", "PAGE_URL"];
// ядро report-shell создаёт DOM, поэтому его константы подставляем заглушками: REPORT_CSS, makeQrSvg
const STUBS = 'const REPORT_CSS = ".stub{}"; const makeQrSvg = (t) => "<svg data-qr=\\"" + t + "\\"></svg>"; const PRODUCT_VERSION = "cowork";';
function load() {
  return evaluate(
    [extractCoreBlock(source, "glossary"), extractCoreBlock(source, "economics"), extractCoreBlock(source, "method"), STUBS,
      region("model"), region("pricing"), region("report"), region("analytics")],
    NAMES
  );
}
const COMPANY = { empCount: 50, empSal: 100000, mgrCount: 5, mgrSal: 100000, ropCount: 1, ropSal: 200000 };
const close = (a, b, label, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${label}: ожидалось ${b}, получено ${a}`);

function run(m, preset) {
  m.applyPreset(preset);
  const res = m.computeAll(COMPANY);
  const tariff = m.resolveTariff(res);
  const sub = m.subscriptionCost(tariff.chosen.id, tariff.months, tariff.seats);
  const econ = m.coworkEconomics(res.totalFot, sub);
  return { res, tariff, sub, econ, company: COMPANY };
}

const EXPECTED = {
  boss:  { tasks: 5, hours: 22.1256, raw: 47.2444,  fot: 35199.75, tier: "pro", seats: 1, gross: 2440,  netYear: 393116.97, payback: 2 },
  sales: { tasks: 5, hours: 20.1356, raw: 47.3278,  fot: 18875.25, tier: "pro", seats: 1, gross: 2440,  netYear: 197223.03, payback: 3 },
  mkt:   { tasks: 5, hours: 15.4922, raw: 29.7333,  fot: 15181.69, tier: "pro", seats: 1, gross: 2440,  netYear: 152900.30, payback: 4 },
  team:  { tasks: 7, hours: 76.5322, raw: 176.0722, fot: 82500.13, tier: "pro", seats: 5, gross: 12200, netYear: 843601.52, payback: 4 }
};

for (const [preset, e] of Object.entries(EXPECTED)) {
  test(`preset ${preset}: hours, tariff and net first year match the accepted reference`, () => {
    const m = load();
    const calc = run(m, preset);
    assert.equal(calc.res.items.length, e.tasks);
    close(calc.res.totalHours, e.hours, "часы с коэффициентом");
    close(calc.res.totalRawHours, e.raw, "сырые часы");
    close(calc.res.totalFot, e.fot, "стоимость времени");
    assert.equal(calc.tariff.rec.tier.id, e.tier, "рекомендуемый тариф");
    assert.equal(calc.tariff.chosen.id, e.tier, "без ручного выбора выбран рекомендуемый");
    assert.equal(calc.tariff.seats, e.seats);
    assert.equal(calc.sub.grossMonth, e.gross);
    close(calc.econ.netFirstYear, e.netYear, "чистая экономия первого года");
    assert.equal(calc.econ.paybackDays, e.payback);
    assert.ok(calc.econ.netFirstYear > 0, "первый год положительный");
  });
}

test("copy text: every line a reader needs, in the accepted order", () => {
  const m = load();
  const calc = run(m, "boss");
  const text = m.buildSummaryText(calc.res, calc.tariff, calc.sub, calc.econ, calc.company, { companyName: "ООО Тест", url: "https://cowork.bitrixgpt.online/" })
    .replace(/\u00a0/g, " ");
  const lines = text.split("\n");
  assert.equal(lines[0], "Расчёт выгоды Коворк/Код — ООО Тест");
  assert.equal(lines[2], "Задачи (часов в месяц с учётом реализуемости):");
  assert.equal(lines[3], "• Еженедельный отчёт по компании: 9,2 ч (освобождается 17 ч, коэффициент 55%)", "задачи отсортированы по часам");
  assert.equal(lines.filter((l) => l.startsWith("• ")).length, 5);
  assert.match(text, /Освобождается: 22 ч в месяц \(≈ 2,8 рабочих дней\), без коэффициента — 47 ч/);
  assert.match(text, /Стоимость этого времени: 35 200 ₽ в месяц\. Ставка часа: руководитель 1 591 ₽\/ч, менеджер 795 ₽\/ч, сотрудник 795 ₽\/ч/);
  assert.match(text, /Тариф: Pro, оплата помесячно — 2 440 ₽ в месяц с НДС/);
  assert.match(text, /Чистая экономия: 32 760 ₽ в месяц, 393 117 ₽ за первый год\. Подписка окупается за 2 раб\. дн\./);
  assert.match(text, /методика NBER w30866\): https:\/\/cowork\.bitrixgpt\.online\/#method/);
  assert.match(text, /Калькулятор: https:\/\/cowork\.bitrixgpt\.online\//);
  assert.match(text, /Цены актуальны на 25 сентября 2026 г\./);
  // ручной тариф и подписки отражаются в тексте
  m.pricing.tierSel = "max"; m.pricing.period = 12; m.pricing.seatsManual = true; m.pricing.seats = 3;
  const calc2 = run(m, "boss");
  const t2 = m.buildSummaryText(calc2.res, calc2.tariff, calc2.sub, calc2.econ, calc2.company, {}).replace(/\u00a0/g, " ");
  assert.match(t2, /Тариф: Max × 3, оплата за 12 мес \(скидка 20%\) — 29 280 ₽ в месяц с НДС \(по задачам подходит Pro\)/);
});

test("report html: sections in the accepted order, task table, costs, method and CTA with QR", () => {
  const m = load();
  const calc = run(m, "team");
  const html = m.buildCoworkReportHtml(calc, { companyName: "ООО «Ромашка»", logo: "data:image/png;base64,AAA", date: "25 сентября 2026 г.", url: "https://cowork.bitrixgpt.online/" })
    .replace(/[\u00a0\u202f]/g, " ");   // разделители разрядов toLocaleString — неразрывные пробелы
  const order = ["Данные о компании", "Задачи и освобождённые часы", "Затраты и тариф", "Методика", "Как начать работать с Коворк/Код"];
  const idx = order.map((s) => html.indexOf(`<p class='sec-eyebrow'>${s}</p>`));
  assert.ok(idx.every((i) => i > 0), "все секции есть");
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, "порядок секций: компания → задачи → затраты → методика → CTA");
  assert.ok(html.indexOf("class='hero'") < idx[0], "эффект идёт первым");
  assert.match(html, /<title>Коворк\/Код — часы и деньги — ООО «Ромашка»<\/title>/);
  assert.match(html, /<img class='logo' src='data:image\/png;base64,AAA'/);
  assert.equal((html.match(/<tr>/g) || []).length, 1 + 7, "заголовок и по строке на задачу (итог — отдельная строка)");
  assert.match(html, /<tr class='sum'><td>Итого<\/td>.*77 ч.*82 500 ₽/);   // 76,53 ч → «77 ч»
  assert.match(html, /Тариф Коворк\/Код — «Pro», подписок: 5, оплата помесячно<\/span><span class='tv'>10 000 Ꝟ\/мес/);
  assert.match(html, /Подписка в рублях с НДС 22%<\/span><span class='tv'>12 200 ₽\/мес · 146 400 ₽\/год/);
  assert.match(html, /Чистая экономия первого года<\/span><span class='tv'>843 602 ₽/);
  assert.ok(html.includes("<div class='method'>"), "METHOD_NOTE ядра");
  assert.ok(html.includes(`data-qr="${m.CTA_COWORK_SELF}"`) && html.includes(`data-qr="${m.CTA_COWORK_HELP}"`), "QR на обе ссылки CTA");
  assert.ok(html.includes("href='https://helpdesk.bitrix24.ru/open/28844790/'"));
  assert.match(html, /Пороги тарифов — ориентир до подтверждения продуктом/);
  assert.match(html, /Рассчитано на cowork\.bitrixgpt\.online/);
  assert.ok(html.includes(".stub{}"), "стили печатной формы — из REPORT_CSS ядра");
  assert.equal(html.includes("undefined"), false, "в отчёте нет undefined");
  assert.equal(html.includes("NaN"), false, "в отчёте нет NaN");
});

test("analytics records: report, copy and session fields as report-logger.gs expects", () => {
  const m = load();
  const calc = run(m, "boss");
  const rep = m.buildCoworkReportRecord(calc, { preset: "boss", companyName: "ООО Тест", iframe: false, host: "https://cowork.bitrixgpt.online/" });
  assert.equal(rep.type, "report");
  assert.equal(rep.version, "cowork");
  assert.equal(rep.deploy, "", "у Коворка нет облака/коробки");
  assert.equal(rep.tariff, "Pro", "tariff — имя тарифа Коворка (общая колонка)");
  assert.equal(rep.tier, "Pro");
  assert.equal(rep.period, 1);
  assert.equal(rep.seats, 1);
  assert.equal(rep.hoursMonth, 22.1);
  assert.equal(rep.rawHoursMonth, 47.2);
  assert.equal(rep.econMonth, 35200);
  assert.equal(rep.econYear, 422397);
  assert.equal(rep.netYear, 393117);
  assert.equal(rep.potMonth, "");
  assert.equal(rep.company, "ООО Тест");
  assert.deepEqual([rep.empCount, rep.empSal, rep.mgrCount, rep.mgrSal, rep.ropCount, rep.ropSal], [50, 100000, 5, 100000, 1, 200000]);
  assert.equal(rep.blocks.split(" | ").length, 5);
  assert.match(rep.blocksDetail, /Еженедельный отчёт по компании=14661/);
  assert.match(rep.ts, /^\d{4}-\d{2}-\d{2}T/);
  for (const k of ["ts", "version", "iframe", "host", "company", "empCount", "empSal", "mgrCount", "mgrSal", "ropCount", "ropSal",
    "blocks", "blocksDetail", "tariff", "econMonth", "econYear", "potMonth", "deploy", "preset", "tier", "period", "seats", "hoursMonth", "rawHoursMonth", "netYear"]) {
    assert.ok(k in rep, `колонка ${k} листа «Отчёты» заполнена`);
  }

  const copy = m.buildCopyRecord(calc, { preset: "boss", iframe: true, host: "https://example.com/" });
  assert.equal(copy.type, "copy");
  for (const k of ["ts", "version", "iframe", "host", "preset", "tier", "period", "seats", "hoursMonth", "econMonth", "netYear"]) {
    assert.ok(k in copy, `колонка ${k} листа «Копии» заполнена`);
  }
  assert.equal(copy.iframe, true);
  assert.equal(copy.netYear, 393117);

  assert.deepEqual(JSON.parse(JSON.stringify(m.coworkSessionFields(calc, { preset: "team", copies: 2 }))), { preset: "team", tier: "Pro", copies: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(m.coworkSessionFields(null, {}))), { preset: "", tier: "", copies: 0 }, "до первого расчёта поля пустые");
});
