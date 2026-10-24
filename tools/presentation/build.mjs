#!/usr/bin/env node
// Сборка презентации для жюри: slides.html → Chromium (Playwright) → docs/Презентация.pdf, один слайд — одна страница.
// Запуск из tools/presentation: node build.mjs [--out docs/Презентация.pdf] [--strict]
// Playwright берётся из tools/docs-pdf/node_modules, шрифт Onest и логотип — из frontend/node_modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');
const SOURCE = 'tools/presentation/slides.html';
const DEFAULT_OUT = 'docs/Презентация.pdf';

// Страница открывается с условного адреса, а запросы к нему обслуживаются файлами репозитория: шрифты, логотип и экраны
// грузятся как с одного сайта, поэтому canvas может вырезать кадр из экрана. В сеть не уходит ни один запрос.
const ORIGIN = 'http://slides.local';
const SLIDE = { width: 1920, height: 1080 };
const SLIDES_EXPECTED = { min: 13, max: 14 };
const MIN_FONT_PX = 20;
const PDF_PAGE_PT = { width: (SLIDE.width * 72) / 96, height: (SLIDE.height * 72) / 96 };

// Без этих файлов сборка невозможна: подсказка, как их получить
const REQUIRED = [
  { file: 'frontend/node_modules/@fontsource/onest/400.css', hint: 'cd frontend && npm ci' },
  { file: 'frontend/node_modules/@alfalab/icons-logotype/AlfaBankLIcon.js', hint: 'cd frontend && npm ci' },
  { file: 'tools/docs-pdf/node_modules/playwright/package.json', hint: 'cd tools/docs-pdf && npm ci' },
];

class BuildError extends Error {}

function rel(file) {
  return file.startsWith(REPO_ROOT + path.sep) ? path.relative(REPO_ROOT, file) : file;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function checkRequired() {
  for (const { file, hint } of REQUIRED) {
    if (!isFile(path.join(REPO_ROOT, file))) throw new BuildError(`нет файла ${file}. Установите зависимости: ${hint}`);
  }
}

function loadPlaywright() {
  const require = createRequire(path.join(REPO_ROOT, 'tools', 'docs-pdf', 'package.json'));
  return require('playwright');
}

async function launchBrowser(chromium) {
  const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
  try {
    return await chromium.launch({ executablePath });
  } catch (error) {
    const hint = executablePath
      ? `не удалось запустить Chromium из PW_CHROMIUM_PATH=${executablePath}`
      : 'не найден Chromium для Playwright: укажите путь к браузеру в PW_CHROMIUM_PATH ' +
        'или установите его командой «npx playwright install chromium» в tools/docs-pdf';
    throw new BuildError(`${hint}.\n${error.message.split('\n')[0]}`);
  }
}

// Обработчик запросов страницы: только GET к условному адресу и только файлы внутри репозитория
function repoServer(log) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== 'GET') {
      log.blocked.add(request.url());
      return route.abort('blockedbyclient');
    }
    const file = path.resolve(REPO_ROOT, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(REPO_ROOT + path.sep) || !isFile(file)) {
      log.missing.add(decodeURIComponent(url.pathname));
      return route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found' });
    }
    return route.fulfill({ path: file });
  };
}

// Проверка вёрстки в странице: размеры слайдов, выход за край, переполненные блоки, мелкий шрифт
function inspectLayout({ slide, minFont }) {
  const problems = [];
  const slides = [...document.querySelectorAll('section.slide')];
  const describe = (el) => {
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '';
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return `<${el.tagName.toLowerCase()}${cls}>${text ? ` «${text.length > 50 ? `${text.slice(0, 50)}…` : text}»` : ''}`;
  };
  slides.forEach((section, index) => {
    const n = index + 1;
    const frame = section.getBoundingClientRect();
    if (Math.abs(frame.width - slide.width) > 0.5 || Math.abs(frame.height - slide.height) > 0.5) {
      problems.push(`слайд ${n}: размер ${frame.width}×${frame.height} вместо ${slide.width}×${slide.height}`);
    }
    for (const el of section.querySelectorAll('*')) {
      if (el.closest('svg') && !(el instanceof SVGSVGElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const out = Math.max(frame.left - box.left, frame.top - box.top, box.right - frame.right, box.bottom - frame.bottom);
      if (out > 0.5) problems.push(`слайд ${n}: ${describe(el)} выходит за край слайда на ${Math.ceil(out)} px`);
      if (!(el instanceof HTMLElement)) continue;
      if (!/hidden|clip|auto|scroll/.test(style.overflow) && style.display !== 'inline' && el.clientWidth > 0) {
        // По высоте глифы крупного шрифта с плотным межстрочным интервалом выступают за строку на несколько пикселей —
        // это не дефект. Лишняя строка текста выступает больше чем на треть кегля.
        const tolerance = Math.max(6, 0.33 * parseFloat(style.fontSize));
        const dx = el.scrollWidth - el.clientWidth;
        const dy = el.scrollHeight - el.clientHeight;
        if (dx > 1 || dy > tolerance) {
          const by = [dx > 1 ? `по ширине на ${dx} px` : '', dy > tolerance ? `по высоте на ${dy} px` : ''].filter(Boolean);
          problems.push(`слайд ${n}: содержимое ${describe(el)} не помещается в блок ${by.join(' и ')}`);
        }
      }
      const ownText = [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent.trim());
      if (ownText && parseFloat(style.fontSize) < minFont - 0.01) {
        problems.push(`слайд ${n}: шрифт ${style.fontSize} мельче ${minFont} px — ${describe(el)}`);
      }
    }
  });
  const titles = slides.map((section) => {
    const heading = section.querySelector('h1, h2');
    return heading ? heading.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  const shots = [...document.querySelectorAll('figure.shot')].map((figure) => {
    const img = figure.querySelector('img');
    return {
      slide: slides.indexOf(figure.closest('section.slide')) + 1,
      alt: img.alt,
      scale: Number(figure.dataset.scale),
      cropped: img.src.startsWith('data:'),
    };
  });
  return { count: slides.length, titles, problems, shots };
}

// Дата в метаданных PDF — из SOURCE_DATE_EPOCH или времени последнего коммита, а не время сборки:
// две сборки одного состояния репозитория дают побайтно одинаковый файл
function sourceDate() {
  let epoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    try {
      epoch = Number(
        execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
      );
    } catch {
      return null;
    }
  }
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const iso = new Date(epoch * 1000).toISOString();
  return `D:${iso.slice(0, 19).replace(/\D/g, '')}+00'00'`;
}

// Строка даты той же длины, что у Chromium, поэтому смещения в таблице xref не меняются
function stampPdfDates(pdfPath, date) {
  const text = fs.readFileSync(pdfPath).toString('latin1');
  const patched = text.replace(/\/(CreationDate|ModDate) \(D:\d{14}[^)]*\)/g, (match, key) => {
    const value = `/${key} (${date})`;
    return value.length === match.length ? value : match;
  });
  if (patched !== text) fs.writeFileSync(pdfPath, Buffer.from(patched, 'latin1'));
}

function pdfInfo(pdfPath) {
  try {
    const out = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pages = Number(/^Pages:\s+(\d+)/m.exec(out)?.[1]);
    const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(out);
    return { pages, width: Number(size?.[1]), height: Number(size?.[2]) };
  } catch {
    const raw = fs.readFileSync(pdfPath, 'latin1');
    return { pages: (raw.match(/\/Type\s*\/Page(?![s\w])/g) || []).length, width: NaN, height: NaN };
  }
}

// Шрифты в PDF: всё должно быть набрано Onest, без подстановки системных шрифтов
function pdfFonts(pdfPath) {
  try {
    const out = execFileSync('pdffonts', [pdfPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out
      .split('\n')
      .slice(2)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return null;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      strict: { type: 'boolean', default: false },
    },
  });
  const outPath = path.resolve(REPO_ROOT, values.out || DEFAULT_OUT);
  checkRequired();
  const { chromium } = loadPlaywright();

  const warnings = [];
  const log = { blocked: new Set(), missing: new Set() };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-'));
  const tmpPdf = path.join(tmpDir, 'slides.pdf');
  let browser;
  try {
    browser = await launchBrowser(chromium);
    const page = await browser.newPage({ viewport: { width: SLIDE.width, height: SLIDE.height } });
    page.on('pageerror', (error) => warnings.push(`ошибка в странице: ${error.message}`));
    await page.route('**/*', repoServer(log));
    // Вёрстка проверяется в том же режиме, в каком печатается
    await page.emulateMedia({ media: 'print' });
    await page.goto(`${ORIGIN}/${SOURCE}`, { waitUntil: 'load' });

    const ready = await page.evaluate(() => window.slidesReady);
    if (!ready) throw new BuildError(`страница не подготовила слайды: нет window.slidesReady в ${SOURCE}`);
    const errors = [...ready.errors, ...[...log.missing].map((p) => `нет файла ${p.replace(/^\//, '')}`)];
    if (errors.length) throw new BuildError(`слайды не готовы:\n  - ${errors.join('\n  - ')}`);

    const report = await page.evaluate(inspectLayout, { slide: SLIDE, minFont: MIN_FONT_PX });
    warnings.push(...report.problems);
    if (report.count < SLIDES_EXPECTED.min || report.count > SLIDES_EXPECTED.max) {
      warnings.push(`слайдов ${report.count}, ожидается ${SLIDES_EXPECTED.min}–${SLIDES_EXPECTED.max}`);
    }
    for (const shot of report.shots) {
      if (!shot.cropped) warnings.push(`слайд ${shot.slide}: экран «${shot.alt}» не вырезан — в PDF попадёт картинка целиком`);
    }
    for (const url of log.blocked) warnings.push(`заблокирован внешний запрос: ${url}`);

    await page.pdf({ path: tmpPdf, preferCSSPageSize: true, printBackground: true, tagged: true });
    const date = sourceDate();
    if (date) stampPdfDates(tmpPdf, date);

    const info = pdfInfo(tmpPdf);
    if (info.pages !== report.count) warnings.push(`в PDF ${info.pages} стр., а слайдов ${report.count}`);
    if (
      Number.isFinite(info.width) &&
      (Math.abs(info.width - PDF_PAGE_PT.width) > 1 || Math.abs(info.height - PDF_PAGE_PT.height) > 1)
    ) {
      warnings.push(`размер страницы PDF ${info.width}×${info.height} pt вместо ${PDF_PAGE_PT.width}×${PDF_PAGE_PT.height}`);
    }
    const fonts = pdfFonts(tmpPdf);
    const foreign = fonts?.filter((name) => !/Onest/i.test(name)) ?? [];
    if (foreign.length) warnings.push(`в PDF есть шрифты кроме Onest: ${[...new Set(foreign)].join(', ')}`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(tmpPdf, outPath);

    report.titles.forEach((title, i) => console.log(`  ${String(i + 1).padStart(2)}. ${title}`));
    const scales = report.shots.map((s) => `${s.slide}: ${Math.round(s.scale * 100)} %`).join(', ');
    console.log(`• Экраны интерфейса, масштаб от исходного PNG — ${scales}`);
    const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1).replace('.', ',');
    const pt = Number.isFinite(info.width) ? `, ${info.width}×${info.height} pt` : '';
    console.log(`• Готово: ${rel(outPath)} — ${info.pages} стр.${pt}, ${sizeMb} МБ`);
  } finally {
    await browser?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
