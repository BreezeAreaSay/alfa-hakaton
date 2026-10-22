#!/usr/bin/env node
// Сопроводительное письмо к сдаче: cover.md → PDF с адресом репозитория, тегом и хешем текущего коммита.
// Запуск из tools/docs-pdf:
//   npm run cover -- [--ref v1.0.0] [--repo-url https://github.com/stonebridgeway/alfa-hakaton]
//                    [--demo-url https://…] [--out out/Сопроводительное-письмо.pdf]
// Адрес демо-версии подставляется по умолчанию; --demo-url '' убирает его из письма.
// Без --ref берётся тег текущего коммита, если он есть, иначе в письме указывается хеш коммита.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PORTRAIT, PX_PER_MM, REPO_ROOT, TOOL_DIR, buildDate, fontFaces, launchBrowser, printPdf } from './build.mjs';
import { escapeHtml, renderDocuments } from './lib/markdown.mjs';

const DEFAULT_REPO = 'https://github.com/stonebridgeway/alfa-hakaton';
const DEFAULT_DEMO = 'https://stonebridgeway.github.io/alfa-hakaton/';
const DEFAULT_OUT = path.join(TOOL_DIR, 'out', 'Сопроводительное-письмо.pdf');

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      ref: { type: 'string' },
      'repo-url': { type: 'string' },
      'demo-url': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const repoUrl = (values['repo-url'] || DEFAULT_REPO).replace(/\/$/, '');
  const commit = gitOutput(['rev-parse', 'HEAD']);
  if (!commit) throw new Error('не удалось определить коммит: запустите из клона репозитория');
  const tag = values.ref || gitOutput(['describe', '--tags', '--exact-match', 'HEAD']);
  const ref = tag || commit;
  const refLine = tag
    ? `тег \`${tag}\`, коммит \`${commit}\``
    : `коммит \`${commit}\` (тег будет проставлен на этот коммит)`;
  const demoUrl = values['demo-url'] ?? DEFAULT_DEMO;
  const demoBlock = demoUrl
    ? `- **Демо-версия интерфейса без сервера** — дополнение к локальному запуску, а не замена: <${demoUrl}>.`
    : '';
  if (gitOutput(['status', '--porcelain'])) {
    console.log('• Внимание: в рабочем каталоге есть незакоммиченные изменения — письмо описывает коммит без них');
  }

  const template = fs.readFileSync(path.join(TOOL_DIR, 'cover.md'), 'utf8');
  const filled = template
    .replaceAll('{{repo_url}}', repoUrl)
    .replaceAll('{{ref}}', ref)
    .replaceAll('{{ref_line}}', refLine)
    .replaceAll('{{date}}', buildDate())
    .replaceAll('{{demo_block}}', demoBlock);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-pdf-'));
  fs.writeFileSync(path.join(tmpDir, 'cover.md'), filled);
  const { docs, warnings } = renderDocuments({
    docs: [{ file: 'cover.md', id: 'cover', title: 'Сопроводительное письмо', n: 1 }],
    repoRoot: tmpDir,
    githubBase: `${repoUrl}/blob/${ref}/`,
  });
  const doc = docs[0];
  const css = fs.readFileSync(path.join(TOOL_DIR, 'page', 'style.css'), 'utf8');
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Сопроводительное письмо к решению</title>
<style>
${fontFaces()}
${css}
@page cover {
  @top-left { content: 'Сопроводительное письмо к решению'; }
  @top-right { content: '${escapeHtml(repoUrl.replace(/^https?:\/\//, ''))}'; }
  @bottom-left { content: 'Умный кредитный кабинет предпринимателя · команда «Альфы»'; }
}
</style>
</head>
<body>
<section class="doc" data-file="cover.md" style="page: cover">
  <header class="doc-head"><h1 id="cover">${doc.titleHtml}</h1></header>
${doc.html}
</section>
</body>
</html>
`;
  const htmlPath = path.join(tmpDir, 'index.html');
  fs.writeFileSync(htmlPath, html);

  const outPath = path.resolve(TOOL_DIR, values.out || DEFAULT_OUT);
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: Math.round(PORTRAIT.width * PX_PER_MM), height: 1000 } });
    await page.emulateMedia({ media: 'print' });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await printPdf(page, outPath);
  } finally {
    await browser?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  const shown = outPath.startsWith(REPO_ROOT + path.sep) ? path.relative(REPO_ROOT, outPath) : outPath;
  console.log(`• Готово: ${shown} — ${tag ? `тег ${tag}, ` : ''}коммит ${commit.slice(0, 12)}`);
  for (const w of warnings) console.log(`  - ${w}`);
}

main().catch((error) => {
  console.error(`Ошибка: ${error.message}`);
  process.exit(1);
});
