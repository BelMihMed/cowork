import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";

// Хелпер тестов Коворка: читает собранный index.html и вытаскивает из него реальный код,
// а не копию формул. Родственник tests/helpers/extract-calculator.mjs из bitrixgpt-calc,
// параметризован именем файла и знает про блоки ядра @core:* (их маркеры сохраняются при сборке).

// порядок блоков входит в хэш ядра — совпадает со списком CORE в build_cowork.py
export const CORE_ORDER = [
  ["tokens", "css"], ["base-css", "css"], ["company-html", "html"],
  ["report-shell", "js"], ["glossary", "js"], ["economics", "js"], ["method", "js"],
  ["company", "js"], ["analytics", "js"], ["info-modal", "js"]
];
const MARK = {
  css:  { start: (n) => `/* @core:${n} */`, end: "/* @core:end */" },
  html: { start: (n) => `<!-- @core:${n} -->`, end: "<!-- @core:end -->" },
  js:   { start: (n) => `// @core:${n}`, end: "// @core:end" }
};

export function readSource(file) {
  return fs.readFileSync(file, "utf8");
}

export function extractCoreBlock(source, name) {
  const entry = CORE_ORDER.find(([n]) => n === name);
  if (!entry) throw new Error(`Unknown core block ${name}`);
  const { start, end } = MARK[entry[1]];
  const lines = source.split("\n");
  const starts = lines.map((l, i) => (l.trim() === start(name) ? i : -1)).filter((i) => i >= 0);
  if (starts.length !== 1) throw new Error(`core marker ${start(name)} found ${starts.length} times`);
  const from = starts[0];
  const to = lines.findIndex((l, i) => i > from && l.trim() === end);
  if (to < 0) throw new Error(`core block ${name} is not closed`);
  const body = lines.slice(from + 1, to).join("\n");
  if (body.includes("@core:")) throw new Error(`core block ${name} contains a nested marker`);
  return body;
}

// sha256[:12] по конкатенации блоков в порядке CORE_ORDER — тот же алгоритм, что в build_cowork.py
export function coreHash(source) {
  const h = createHash("sha256");
  for (const [name] of CORE_ORDER) h.update(`@core:${name}\n${extractCoreBlock(source, name)}\n`, "utf8");
  return h.digest("hex").slice(0, 12);
}

export function stampedCoreHash(source) {
  const m = source.match(/<!-- core: ([0-9a-f]{12}) -->/);
  return m ? m[1] : null;
}

// глоссарий ядра: константы и форматтеры, выполненные в изолированном контексте
export function loadGlossary(file) {
  const source = readSource(file);
  const context = vm.createContext({});
  new vm.Script(extractCoreBlock(source, "glossary"), { filename: "core-glossary.js" }).runInContext(context);
  const g = (expr) => new vm.Script(expr).runInContext(context);
  return {
    TAX: g("TAX"), HOURS_MONTH: g("HOURS_MONTH"), DAY_HOURS: g("DAY_HOURS"), DAYS_MONTH: g("DAYS_MONTH"),
    WEEKS_MONTH: g("WEEKS_MONTH"), VAT: g("VAT"),
    costHour: g("costHour"), costMinute: g("costMinute"),
    groupFmt: g("groupFmt"), parseNum: g("parseNum"), fmtMoney: g("fmtMoney"), fmtInt: g("fmtInt"),
    source
  };
}

// ---------- извлечение продуктовых объявлений по балансу скобок (для тестов T6/T7) ----------

function findBalancedEnd(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error(`Cannot find matching ${closeChar}`);
}

export function extractDeclaration(source, marker, openChar, closeChar) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Cannot find ${marker}`);
  const openIndex = source.indexOf(openChar, start);
  if (openIndex < 0) throw new Error(`Cannot find ${openChar} after ${marker}`);
  const end = findBalancedEnd(source, openIndex, openChar, closeChar);
  let semicolon = end + 1;
  while (/\s/.test(source[semicolon] || "")) semicolon += 1;
  if (source[semicolon] === ";") semicolon += 1;
  return source.slice(start, semicolon);
}

export function extractFunction(source, name) {
  return extractDeclaration(source, `function ${name}`, "{", "}");
}

// выполняет набор фрагментов исходника в одном контексте и возвращает значения перечисленных имён
export function evaluate(fragments, names, sandbox = {}) {
  const context = vm.createContext(sandbox);
  new vm.Script(fragments.join("\n"), { filename: "cowork-extract.js" }).runInContext(context);
  return Object.fromEntries(names.map((n) => [n, new vm.Script(n).runInContext(context)]));
}
