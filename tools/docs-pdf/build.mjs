#!/usr/bin/env node
// Сборка документации проекта в один PDF: Markdown → HTML → Chromium (Playwright) → PDF.
// Запуск: npm run build (из tools/docs-pdf). Подробности — в README.md рядом.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { escapeHtml, renderDocuments } from './lib/markdown.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');
const require = createRequire(import.meta.url);

// Документы в порядке следования. optional — включается, только если файл есть.
const DOCUMENTS = [
  { file: 'README.md', title: 'Обзор проекта' },
  { file: 'docs/product.md' },
  { file: 'docs/requirements.md' },
  { file: 'docs/architecture.md' },
  { file: 'docs/process.md' },
  { file: 'docs/credit-policy.md' },
  { file: 'docs/data-model.md' },
  { file: 'docs/api.md' },
  { file: 'docs/test-scenarios.md' },
  { file: 'docs/ai.md' },
  { file: 'docs/design.md' },
  { file: 'docs/deploy.md' },
  { file: 'docs/demo-mode.md', optional: true },
  { file: 'docs/research/interview-guide.md' },
];

// Не входят в PDF, на странице содержания — ссылки на репозиторий.
const NOT_INCLUDED = [
  { file: 'docs/plan.md', note: 'рабочий черновик плана, устарел' },
  {
    file: 'THIRD_PARTY_NOTICES',
    note: 'сторонние компоненты, модели, данные и смоделированные интеграции; длинные сгенерированные таблицы лицензий',
  },
];

const DEFAULTS = {
  out: 'docs/Документация-проекта.pdf',
  githubBase: 'https://github.com/BreezeAreaSay/alfa-hakaton/blob/main/',
};

// Геометрия страницы — та же, что в @page в page/style.css (поля 20, 18, 17, 18 мм).
const PX_PER_MM = 96 / 25.4;
const PORTRAIT = { width: 210 - 36, height: 297 - 37 };
const LANDSCAPE = { width: 297 - 36, height: 210 - 37 };
// Над диаграммой может стоять заголовок, под ней — подпись: оставляем запас по высоте.
const DIAGRAM_BOXES = {
  portrait: { width: PORTRAIT.width * PX_PER_MM, maxHeight: (PORTRAIT.height - 22) * PX_PER_MM },
  landscape: { width: LANDSCAPE.width * PX_PER_MM, maxHeight: (LANDSCAPE.height - 22) * PX_PER_MM },
};

const ONEST_DIR = path.join(REPO_ROOT, 'frontend', 'node_modules', '@fontsource', 'onest');
// cyrillic и latin — основной текст; latin-ext — знак ₽, math — стрелки и ≈, ≥.
const ONEST_SUBSETS = ['cyrillic', 'latin', 'latin-ext', 'math'];
const ONEST_WEIGHTS = [400, 500, 700];

const MERMAID_FONT = '"Onest", "Inter", "DejaVu Sans", sans-serif';
const MERMAID_CONFIG = {
  theme: 'base',
  securityLevel: 'strict',
  fontFamily: MERMAID_FONT,
  themeVariables: {
    fontFamily: MERMAID_FONT,
    fontSize: '14px',
    background: '#ffffff',
    textColor: '#212124',
    primaryColor: '#f2f3f5',
    primaryTextColor: '#212124',
    primaryBorderColor: '#898991',
    secondaryColor: '#ffffff',
    secondaryTextColor: '#212124',
    secondaryBorderColor: '#b8b9c0',
    tertiaryColor: '#ffffff',
    tertiaryTextColor: '#212124',
    tertiaryBorderColor: '#b8b9c0',
    lineColor: '#75757d',
    mainBkg: '#f2f3f5',
    nodeBorder: '#898991',
    clusterBkg: '#fafafb',
    clusterBorder: '#d5d6dc',
    titleColor: '#212124',
    edgeLabelBackground: '#ffffff',
    actorBkg: '#f2f3f5',
    actorBorder: '#898991',
    actorTextColor: '#212124',
    actorLineColor: '#b8b9c0',
    signalColor: '#212124',
    signalTextColor: '#212124',
    labelBoxBkgColor: '#f2f3f5',
    labelBoxBorderColor: '#b8b9c0',
    labelTextColor: '#212124',
    loopTextColor: '#212124',
    noteBkgColor: '#f2f3f5',
    noteBorderColor: '#b8b9c0',
    noteTextColor: '#212124',
    activationBkgColor: '#e7e8ea',
    activationBorderColor: '#898991',
    sequenceNumberColor: '#ffffff',
    attributeBackgroundColorOdd: '#ffffff',
    attributeBackgroundColorEven: '#f8f8fa',
  },
  flowchart: { htmlLabels: true, useMaxWidth: false },
  // Длинные подписи сообщений переносятся, иначе диаграмма выходит втрое шире страницы.
  // wrapPadding меньше умолчания — иначе подпись цикла (loop) рвётся на слова.
  sequence: {
    useMaxWidth: false,
    mirrorActors: false,
    wrap: true,
    wrapPadding: 5,
    width: 150,
    actorMargin: 40,
    messageMargin: 30,
    boxMargin: 8,
    actorFontFamily: MERMAID_FONT,
    noteFontFamily: MERMAID_FONT,
    messageFontFamily: MERMAID_FONT,
    actorFontSize: 14,
    noteFontSize: 14,
    messageFontSize: 14,
  },
  state: { useMaxWidth: false },
  er: { useMaxWidth: false },
};

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

function normalizeBase(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function git(args) {
  try {
    const out = execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function projectVersion() {
  return process.env.DOCS_VERSION || git(['describe', '--tags', '--abbrev=0']) || git(['describe', '--always']) || '—';
}

function buildDate() {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const date = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date();
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function cssString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ')}"`;
}

function fontFaces() {
  if (!fs.existsSync(path.join(ONEST_DIR, 'files'))) {
    fail(`не найден шрифт Onest (${path.relative(REPO_ROOT, ONEST_DIR)}). Установите зависимости фронтенда: cd frontend && npm ci`);
  }
  const rules = [];
  for (const weight of ONEST_WEIGHTS) {
    // Диапазоны символов наборов — из общего файла начертания (400.css и т. д.).
    const weightCss = path.join(ONEST_DIR, `${weight}.css`);
    const blocks = fs.existsSync(weightCss) ? fs.readFileSync(weightCss, 'utf8').split('@font-face') : [];
    for (const subset of ONEST_SUBSETS) {
      const name = `onest-${subset}-${weight}-normal.woff2`;
      const file = path.join(ONEST_DIR, 'files', name);
      if (!fs.existsSync(file)) fail(`нет файла шрифта ${path.relative(REPO_ROOT, file)}`);
      const block = blocks.find((b) => b.includes(`/${name}`));
      const range = block && /unicode-range:\s*([^;]+);/.exec(block)?.[1];
      const data = fs.readFileSync(file).toString('base64');
      rules.push(
        `@font-face { font-family: 'Onest'; font-style: normal; font-weight: ${weight}; font-display: block; ` +
          `src: url(data:font/woff2;base64,${data}) format('woff2');${range ? ` unicode-range: ${range};` : ''} }`,
      );
    }
  }
  return rules.join('\n');
}

function tocEntry({ target, title, num }) {
  return (
    `<a href="#${target}">` +
    (num ? `<span class="toc-num">${num}</span>` : '') +
    `<span class="toc-title">${escapeHtml(title)}</span><span class="toc-leader"></span>` +
    `<span class="toc-page" data-target="${target}"></span></a>`
  );
}

function buildHtml({ docs, version, date, githubBase }) {
  const repoUrl = githubBase.replace(/(\/-)?\/(blob|tree)\/[^/]+\/$/, '');
  const repoLabel = repoUrl.replace(/^https?:\/\//, '');
  const total = docs.length;

  // У каждого документа своя именованная страница — в верхнем колонтитуле его название и файл.
  // Вариант «-wide» — альбомная страница для крупных диаграмм.
  const pageRules = docs
    .map((d) => {
      const header = `@top-left { content: ${cssString(d.title)}; } @top-right { content: ${cssString(d.file)}; }`;
      return `@page ${d.id} { ${header} }\n@page ${d.id}-wide { size: A4 landscape; ${header} }`;
    })
    .join('\n');

  const cover = `
<section class="cover">
  <div class="cover-case">Кейс Альфа-Банка · Хакатон «Альфа Будущее»</div>
  <div class="cover-main">
    <div class="cover-rule"></div>
    <div class="cover-title">Умный кредитный кабинет предпринимателя</div>
    <div class="cover-subtitle">Документация проекта</div>
  </div>
  <dl class="cover-meta">
    <div><dt>Версия</dt><dd>${escapeHtml(version)}</dd></div>
    <div><dt>Дата сборки</dt><dd>${escapeHtml(date)}</dd></div>
    <div><dt>Репозиторий</dt><dd><a href="${escapeHtml(repoUrl)}">${escapeHtml(repoLabel)}</a></dd></div>
  </dl>
</section>`;

  const tocItems = docs
    .map((d) => {
      const subs = d.sections
        .map((s) => `<li>${tocEntry({ target: s.id, title: s.text })}</li>`)
        .join('');
      return (
        `<li class="toc-doc">${tocEntry({ target: d.id, title: d.title, num: d.n })}` +
        (subs ? `<ol class="toc-sub">${subs}</ol>` : '') +
        '</li>'
      );
    })
    .join('\n');

  const notIncluded = NOT_INCLUDED.map(
    (x, i, all) =>
      `<li><a href="${escapeHtml(githubBase + x.file)}">${escapeHtml(x.file)}</a> — ${escapeHtml(x.note)}` +
      `${i < all.length - 1 ? ';' : '.'}</li>`,
  ).join('');

  const toc = `
<section class="toc" data-file="toc">
  <h1 id="toc">Содержание</h1>
  <ol class="toc-docs">
${tocItems}
  </ol>
  <div class="toc-note">
    <p>В этот файл не вошли — они есть в репозитории:</p>
    <ul>${notIncluded}</ul>
  </div>
</section>`;

  const sections = docs
    .map(
      (d) => `
<section class="doc" data-file="${escapeHtml(d.file)}" style="page: ${d.id}">
  <header class="doc-head">
    <div class="doc-kicker">Документ ${d.n} из ${total} · ${escapeHtml(d.file)}</div>
    <h1 id="${d.id}">${d.titleHtml}</h1>
  </header>
${d.html}
</section>`,
    )
    .join('\n');

  const css = fs.readFileSync(path.join(TOOL_DIR, 'page', 'style.css'), 'utf8');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Умный кредитный кабинет предпринимателя — документация проекта</title>
<style>
${fontFaces()}
${css}
${pageRules}
</style>
</head>
<body>
${cover}
${toc}
${sections}
</body>
</html>
`;
}

// Номера страниц по именованным назначениям PDF (якорям ссылок): { id: страница }.
function readDestinations(pdfPath) {
  let out;
  try {
    out = execFileSync('pdfinfo', ['-dests', pdfPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const pages = {};
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+\[.*\]\s+"(.*)"\s*$/.exec(line);
    if (m) pages[m[2]] = Number(m[1]);
  }
  return pages;
}

// Chromium в закладках PDF удваивает заголовки, которые начинаются с новой страницы
// («АрхитектураАрхитектура»). Исправляем на месте: строка заменяется одинарной и добивается пробелами,
// длина файла и смещения в таблице xref не меняются.
function fixOutlineTitles(pdfPath, headings) {
  const text = fs.readFileSync(pdfPath).toString('latin1');
  let fixed = 0;
  const patch = (match, value, half, title) => {
    if (!headings.has(title.trim())) return match;
    fixed++;
    const single = match.replace(value, half);
    return single + ' '.repeat(match.length - single.length);
  };
  // Заголовки с кириллицей записаны строкой UTF-16 в hex, латинские — литералом в скобках.
  const patched = text
    .replace(/\/Title\s*<FEFF([0-9A-Fa-f]+)>/g, (match, hex) => {
      const half = hex.slice(0, hex.length / 2);
      if (hex.length % 8 !== 0 || half.toUpperCase() !== hex.slice(hex.length / 2).toUpperCase()) return match;
      return patch(match, hex, half, Buffer.from(half, 'hex').swap16().toString('utf16le'));
    })
    .replace(/\/Title\s*\(([^()\\]*)\)/g, (match, literal) => {
      const half = literal.slice(0, literal.length / 2);
      if (!literal || literal.length % 2 !== 0 || half !== literal.slice(literal.length / 2)) return match;
      return patch(match, literal, half, half);
    });
  if (fixed) fs.writeFileSync(pdfPath, Buffer.from(patched, 'latin1'));
  return fixed;
}

function pageCount(pdfPath) {
  try {
    const out = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(/^Pages:\s+(\d+)/m.exec(out)?.[1]) || null;
  } catch {
    const raw = fs.readFileSync(pdfPath, 'latin1');
    return (raw.match(/\/Type\s*\/Page(?![s\w])/g) || []).length || null;
  }
}

// Ожидаемая ошибка: печатается одной строкой, без стека.
class BuildError extends Error {}

async function launchBrowser() {
  const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
  try {
    return await chromium.launch({ executablePath });
  } catch (error) {
    const hint = executablePath
      ? `не удалось запустить Chromium из PW_CHROMIUM_PATH=${executablePath}`
      : 'не найден Chromium для Playwright. Установите его командой «npx playwright install chromium» в tools/docs-pdf ' +
        'или укажите путь к браузеру в переменной PW_CHROMIUM_PATH';
    throw new BuildError(`${hint}.\n${error.message.split('\n')[0]}`);
  }
}

async function printPdf(page, file) {
  await page.pdf({
    path: file,
    preferCSSPageSize: true,
    printBackground: true,
    outline: true,
    tagged: true,
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'github-base': { type: 'string' },
      'keep-html': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
    },
  });
  const githubBase = normalizeBase(values['github-base'] || process.env.DOCS_GITHUB_BASE || DEFAULTS.githubBase);
  const outPath = path.resolve(REPO_ROOT, values.out || DEFAULTS.out);

  const selected = [];
  for (const doc of DOCUMENTS) {
    if (fs.existsSync(path.join(REPO_ROOT, doc.file))) selected.push({ ...doc, n: selected.length + 1 });
    else if (doc.optional) console.log(`• ${doc.file} нет — пропущен`);
    else fail(`нет файла ${doc.file}`);
  }

  const { docs, warnings } = renderDocuments({ docs: selected, repoRoot: REPO_ROOT, githubBase });
  const html = buildHtml({ docs, version: projectVersion(), date: buildDate(), githubBase });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-pdf-'));
  const htmlPath = path.join(tmpDir, 'index.html');
  fs.writeFileSync(htmlPath, html);

  let browser;
  try {
    browser = await launchBrowser();
    // Ширина окна = ширина текста на странице, чтобы проверки ширины в browser.js совпадали с печатью.
    const page = await browser.newPage({
      viewport: { width: Math.round(PORTRAIT.width * PX_PER_MM), height: 1000 },
    });
    page.on('pageerror', (error) => warnings.push(`ошибка в странице: ${error.message}`));
    await page.emulateMedia({ media: 'print' });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') });
    await page.addScriptTag({ path: path.join(TOOL_DIR, 'page', 'browser.js') });

    const report = await page.evaluate((options) => window.docsPdf.prepare(options), {
      ...DIAGRAM_BOXES,
      mermaidConfig: MERMAID_CONFIG,
    });

    for (const d of report.diagrams) {
      if (d.error) {
        warnings.push(`${d.source}: диаграмма не отрисована — ${d.error.replace(/\s*\n[\s-]*\^?\s*/g, ' ')}`);
        continue;
      }
      const where = d.placement === 'landscape' ? ', альбомная страница' : '';
      console.log(
        `• Диаграмма ${d.source}: ${d.width}×${d.height}, ${d.layout}, масштаб ${Math.round(d.scale * 100)} %${where}`,
      );
    }
    for (const t of report.tables) {
      if (!t.fits) warnings.push(`${t.doc}: таблица «${t.head}» шире страницы`);
    }
    for (const o of report.overflow) {
      warnings.push(`${o.doc}: <${o.tag}> выходит за поле на ${o.by} px: «${o.text}»`);
    }

    // Номера страниц в содержании: печать → страницы якорей из PDF → номера в содержание → печать.
    // Ширина колонки номеров фиксирована, поэтому вёрстка не сдвигается; повторяем, пока номера не сойдутся.
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll('.toc-page[data-target]')].map((el) => el.dataset.target),
    );
    let current = path.join(tmpDir, 'pass-1.pdf');
    await printPdf(page, current);
    let pages = readDestinations(current);
    if (!pages) {
      warnings.push('pdfinfo (poppler-utils) не найден — номера страниц в содержании не проставлены');
    } else {
      for (let pass = 2; pass <= 4; pass++) {
        await page.evaluate((p) => window.docsPdf.setPageNumbers(p), pages);
        current = path.join(tmpDir, `pass-${pass}.pdf`);
        await printPdf(page, current);
        const check = readDestinations(current);
        const settled = targets.every((t) => check[t] === pages[t]);
        pages = check;
        if (settled) break;
      }
      const missing = targets.filter((t) => !pages[t]);
      if (missing.length) warnings.push(`нет номеров страниц для пунктов содержания: ${missing.join(', ')}`);
    }

    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => h.textContent.trim()),
    );
    fixOutlineTitles(current, new Set(headings));

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(current, outPath);

    const count = pageCount(outPath);
    const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1).replace('.', ',');
    const diagrams = report.diagrams.filter((d) => !d.error).length;
    console.log(`• Документов: ${docs.length}, диаграмм: ${diagrams}, таблиц с подгонкой: ${report.tables.length}`);
    const shown = outPath.startsWith(REPO_ROOT + path.sep) ? path.relative(REPO_ROOT, outPath) : outPath;
    console.log(`• Готово: ${shown} — ${count ?? '?'} стр., ${sizeMb} МБ`);
    if (values['keep-html']) console.log(`• HTML: ${htmlPath}`);
  } finally {
    await browser?.close();
    if (!values['keep-html']) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (warnings.length) {
    console.log(`\nПредупреждения (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
    if (values.strict) process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof BuildError ? `Ошибка: ${error.message}` : error);
  process.exit(1);
});
