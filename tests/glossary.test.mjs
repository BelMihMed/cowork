import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_ORDER,
  coreHash,
  extractCoreBlock,
  loadGlossary,
  readSource,
  stampedCoreHash
} from "./helpers/extract-calculator.mjs";

// Страница Коворка собирается из ядра канона BitrixGPT (build_cowork.py). Эти тесты — защита от дрифта:
// константы ядра равны эталону, хэш ядра в файле совпадает с пересчитанным, все блоки на месте.

const INDEX_FILE = new URL("../index.html", import.meta.url);
const source = readSource(INDEX_FILE);
const glossary = loadGlossary(INDEX_FILE);

test("core glossary: constants equal the shared baseline 1.4 / 176 / 8 / 22 / 52÷12 / 0.22", () => {
  assert.equal(glossary.TAX, 1.4);
  assert.equal(glossary.HOURS_MONTH, 176);
  assert.equal(glossary.DAY_HOURS, 8);
  assert.equal(glossary.DAYS_MONTH, 22);
  assert.equal(glossary.WEEKS_MONTH, 52 / 12);
  assert.equal(glossary.VAT, 0.22);
  // собственных значений сборки (165 ч, ×1,3, 21 день) на странице нет
  for (const stale of ["165", "1.3", "/21", "21)"]) {
    assert.equal(extractCoreBlock(source, "glossary").includes(stale), false, `в глоссарии нет устаревшего ${stale}`);
  }
});

test("core glossary: hourly rate and number formatting come from the core", () => {
  assert.ok(Math.abs(glossary.costHour(100000) - 795.454545) < 0.001, "ставка = оклад × 1,4 ÷ 176");
  assert.ok(Math.abs(glossary.costMinute(100000) - 13.257576) < 0.001);
  assert.equal(glossary.groupFmt("1234567.5"), "1 234 567.5");
  assert.equal(glossary.parseNum("1 234,5"), 1234.5);
  assert.equal(glossary.parseNum("-3"), 3, "отрицательных значений нет");
  assert.equal(glossary.fmtInt(1234).replace(/ /g, " "), "1 234");
});

test("core hash: the stamp in index.html matches the blocks actually present", () => {
  const stamped = stampedCoreHash(source);
  assert.match(stamped || "", /^[0-9a-f]{12}$/, "в файле есть комментарий <!-- core: sha12 -->");
  assert.equal(coreHash(source), stamped, "ядро в файле не правили руками — пересоберите build_cowork.py");
});

test("core blocks: all ten are present exactly once and closed", () => {
  for (const [name] of CORE_ORDER) {
    const body = extractCoreBlock(source, name);
    assert.ok(body.trim().length > 0, `блок ${name} не пустой`);
  }
  const names = (source.match(/@core:[\w-]+/g) || []).map((m) => m.slice(6));
  assert.equal(names.filter((n) => n === "end").length, CORE_ORDER.length, "у каждого блока ровно один @core:end");
  assert.deepEqual([...names.filter((n) => n !== "end")].sort(), CORE_ORDER.map(([n]) => n).sort());
});

test("product wiring: generated page declares itself as cowork and relabels the company block", () => {
  assert.match(source, /const PRODUCT_VERSION = "cowork";/);
  assert.match(source, /Файл собран build_cowork\.py/);
  const company = extractCoreBlock(source, "company-html");
  assert.ok(company.includes("<label>Руководителей</label>"), "роль РОП переименована в «Руководителей»");
  assert.ok(company.includes("<label>ЗП руководителя</label>"));
  assert.equal(company.includes("РОП"), false, "упоминаний РОПа не осталось");
  for (const key of ["empCount", "empSal", "mgrCount", "mgrSal", "ropCount", "ropSal"]) {
    assert.ok(company.includes(`data-comp="${key}"`), `ключ поля ${key} сохранён ради аналитики`);
  }
  assert.equal(source.includes("@int:"), false, "serv-специфика BitrixGPT в страницу не попала");
  assert.equal(source.includes("b24-row"), false, "строки «Ваш Битрикс24» на странице Коворка нет");
});
