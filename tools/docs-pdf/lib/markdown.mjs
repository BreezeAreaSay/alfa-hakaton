// Markdown → HTML для PDF: якоря заголовков как на GitHub, ссылки между документами,
// заготовки для диаграмм Mermaid, таблицы и блоки кода под печать.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';

// Длинные блоки кода можно разрывать между страницами, короткие — нет.
const SHORT_CODE_LINES = 20;
// Код в ячейке таблицы длиннее этого получает точки переноса.
const LONG_CODE_IN_TABLE = 20;
// Пункт списка «текст: + блок» не длиннее этого (строк исходника) не разрывается.
const SHORT_LIST_ITEM_LINES = 15;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Якорь заголовка по правилам GitHub (github-slugger): нижний регистр, всё, кроме букв, цифр,
// знаков-модификаторов, «_», «-» и пробелов, удаляется, пробелы заменяются дефисами.
export function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

class Slugger {
  constructor() {
    this.seen = new Map();
  }

  slug(text) {
    const base = githubSlug(text);
    let result = base;
    while (this.seen.has(result)) {
      const n = this.seen.get(base) + 1;
      this.seen.set(base, n);
      result = `${base}-${n}`;
    }
    this.seen.set(result, 0);
    return result;
  }
}

function inlineText(children = []) {
  return children
    .map((t) => {
      if (t.type === 'text' || t.type === 'code_inline') return t.content;
      if (t.type === 'softbreak' || t.type === 'hardbreak') return ' ';
      if (t.type === 'image') return inlineText(t.children);
      return '';
    })
    .join('');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function createParser() {
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

  // Списки задач GitHub: «- [ ] …» и «- [x] …».
  md.core.ruler.after('inline', 'task_lists', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open') continue;
      if (tokens[i - 2].type !== 'list_item_open') continue;
      const first = inline.children?.[0];
      const m = first?.type === 'text' && /^\[([ xX])\]\s+/.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<span class="task-box${m[1] === ' ' ? '' : ' task-box--done'}"></span>`;
      inline.children.unshift(box);
      tokens[i - 2].attrJoin('class', 'task-item');
    }
  });

  // Абзац с двоеточием в конце вводит следующий блок — в PDF они не разрываются.
  // В «плотном» списке абзац без <p>, поэтому неразрывным делается короткий пункт целиком.
  const introduces = /^(fence|code_block|table_open|bullet_list_open|ordered_list_open|blockquote_open)$/;
  md.core.ruler.push('lead_in', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i + 3 < tokens.length; i++) {
      if (tokens[i].type !== 'paragraph_open') continue;
      if (!/:\s*$/.test(tokens[i + 1].content) || !introduces.test(tokens[i + 3].type)) continue;
      if (!tokens[i].hidden) {
        tokens[i].attrJoin('class', 'lead-in');
        continue;
      }
      const item = tokens[i - 1];
      if (item?.type === 'list_item_open' && item.map && item.map[1] - item.map[0] <= SHORT_LIST_ITEM_LINES) {
        item.attrJoin('class', 'keep-together');
      }
    }
  });

  const rules = md.renderer.rules;

  rules.fence = (tokens, idx, options, env) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
    const line = (token.map?.[0] ?? 0) + 1;
    if (lang === 'mermaid') {
      return (
        `<figure class="diagram" data-source="${escapeHtml(`${env.file}:${line}`)}">` +
        `<pre class="mermaid-code" hidden>${escapeHtml(token.content)}</pre>` +
        `<div class="diagram-body"></div></figure>\n`
      );
    }
    return renderCode(token.content, lang);
  };

  rules.code_block = (tokens, idx) => renderCode(tokens[idx].content, '');

  rules.table_open = (tokens, idx, options, env) => {
    let cols = 0;
    for (let i = idx + 1; i < tokens.length && tokens[i].type !== 'tr_close'; i++) {
      if (tokens[i].type === 'th_open') cols++;
    }
    env.inTable = true;
    const size = cols >= 7 ? 'table--xwide' : cols >= 5 ? 'table--wide' : '';
    return `<div class="table-wrap"><table class="cols-${cols} ${size}">\n`;
  };

  rules.table_close = (tokens, idx, options, env) => {
    env.inTable = false;
    return '</table></div>\n';
  };

  // В таблицах колонки узкие: длинные пути и идентификаторы можно переносить после «/» и «_».
  // Короткие не трогаем, чтобы не рвать 127.0.0.1 или POSTGRES_PASSWORD.
  rules.code_inline = (tokens, idx, options, env) => {
    const content = tokens[idx].content;
    if (!env.inTable || content.length <= LONG_CODE_IN_TABLE) return `<code>${escapeHtml(content)}</code>`;
    const parts = content.split(/(?<=\/)(?!\/)|(?<=[_&?=,])/);
    return `<code>${parts.map(escapeHtml).join('<wbr>')}</code>`;
  };

  return md;
}

function renderCode(content, lang) {
  const lines = content.replace(/\n$/, '').split('\n');
  const body = lines
    .map((line) => {
      const indent = /^ */.exec(line)[0].length;
      const hang = Math.min(indent, 24) + 2;
      const text = line.length ? escapeHtml(line) : ' ';
      return `<span class="ln" style="--hang:${hang}ch">${text}</span>`;
    })
    .join('');
  const cls = ['code', lines.length <= SHORT_CODE_LINES ? 'code--short' : ''].filter(Boolean).join(' ');
  const label = lang && lang !== 'text' ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  return `<pre class="${cls}">${label}<code>${body}</code></pre>\n`;
}

/**
 * Разбирает и отрисовывает документы.
 * docs: [{ file (путь от корня репозитория), title? (заголовок вместо первого H1), n }]
 * Возвращает документы с html, заголовком, разделами второго уровня и список предупреждений.
 */
export function renderDocuments({ docs, repoRoot, githubBase }) {
  const md = createParser();
  const warnings = [];
  const byFile = new Map();

  // Проход 1: разбор, якоря заголовков, оглавление каждого документа.
  for (const doc of docs) {
    const source = fs.readFileSync(path.join(repoRoot, doc.file), 'utf8');
    const env = { file: doc.file };
    const tokens = md.parse(source, env);
    const slugger = new Slugger();
    const anchors = new Map();
    const sections = [];
    const docId = `doc-${doc.n}`;
    let title = null;
    let titleInline = null;
    let titleAt = -1;
    let headingNo = 0;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      const text = inlineText(inline.children).trim();
      const slug = slugger.slug(text);
      let id;
      if (token.tag === 'h1' && title === null) {
        // Заголовок документа выводится в шапке раздела (build.mjs), из потока он убирается.
        title = doc.title || text;
        id = docId;
        titleAt = i;
        titleInline = inline;
        if (doc.title && doc.title !== text) {
          const replacement = new inline.constructor('text', '', 0);
          replacement.content = doc.title;
          inline.children = [replacement];
        }
      } else {
        if (token.tag === 'h1') {
          // Второй и следующие H1 в документе становятся разделами второго уровня.
          token.tag = 'h2';
          tokens[i + 2].tag = 'h2';
        }
        headingNo++;
        id = `${docId}-s${headingNo}`;
        if (token.tag === 'h2') sections.push({ id, text });
      }
      token.attrSet('id', id);
      anchors.set(slug, id);
    }

    if (title === null) {
      title = doc.title || path.basename(doc.file, path.extname(doc.file));
      warnings.push(`${doc.file}: нет заголовка первого уровня, в PDF раздел назван «${title}»`);
    } else {
      tokens.splice(titleAt, 3);
    }

    const entry = { ...doc, id: docId, title, titleInline, tokens, env, anchors, sections, source };
    byFile.set(doc.file, entry);
  }

  // Проход 2: ссылки и HTML.
  const results = [];
  for (const entry of byFile.values()) {
    const sourceLines = entry.source.split('\n');
    const inlines = entry.titleInline ? [entry.titleInline, ...entry.tokens] : entry.tokens;
    for (const token of inlines) {
      if (token.type !== 'inline' || !token.children) continue;
      const children = token.children;
      for (let i = 0; i < children.length; i++) {
        const link = children[i];
        if (link.type === 'image') {
          // Картинки лежат рядом с документом (docs/screenshots), а HTML печатается из временного каталога:
          // путь становится абсолютным относительно каталога документа, как его понимает GitHub
          const src = link.attrGet('src') || '';
          if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) {
            const file = path.resolve(repoRoot, path.dirname(entry.file), safeDecode(src.split('#')[0]));
            if (fs.existsSync(file)) link.attrSet('src', pathToFileURL(file).href);
            else warnings.push(`${entry.file}:${findLine(sourceLines, token.map, src)}: картинка «${src}» не найдена`);
          }
          continue;
        }
        if (link.type !== 'link_open') continue;
        const href = link.attrGet('href') || '';
        const where = () => `${entry.file}:${findLine(sourceLines, token.map, href)}`;
        const resolved = resolveLink(href, entry, { byFile, repoRoot, githubBase });
        if (resolved.warning) warnings.push(`${where()}: ${resolved.warning}`);
        if (resolved.href) {
          link.attrSet('href', resolved.href);
          link.attrJoin('class', `link--${resolved.kind}`);
        } else {
          // Цели нет: оставляем текст без ссылки.
          link.tag = 'span';
          link.attrs = [['class', 'link--broken']];
          const close = findClose(children, i);
          if (close) close.tag = 'span';
        }
      }
    }
    entry.env.inTable = false;
    const html = md.renderer.render(entry.tokens, md.options, entry.env);
    const titleHtml = entry.titleInline
      ? md.renderer.renderInline(entry.titleInline.children, md.options, entry.env)
      : escapeHtml(entry.title);
    results.push({
      n: entry.n,
      file: entry.file,
      id: entry.id,
      title: entry.title,
      titleHtml,
      sections: entry.sections,
      html,
    });
  }
  return { docs: results, warnings };
}

function findClose(children, openIdx) {
  let depth = 0;
  for (let j = openIdx; j < children.length; j++) {
    if (children[j].type === 'link_open') depth++;
    if (children[j].type === 'link_close' && --depth === 0) return children[j];
  }
  return null;
}

// Строка ссылки в исходнике — для предупреждений. У ячеек таблиц нет map, тогда ищем по всему файлу.
function findLine(lines, map, href) {
  const [from, to] = map || [0, lines.length];
  const needles = [href, safeDecode(href)].map((h) => `](${h}`);
  for (let i = from; i < Math.min(to, lines.length); i++) {
    if (needles.some((n) => lines[i].includes(n))) return i + 1;
  }
  return from + 1;
}

function resolveLink(href, entry, { byFile, repoRoot, githubBase }) {
  if (!href) return { warning: 'пустая ссылка' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    return { kind: 'external', href };
  }

  const hashAt = href.indexOf('#');
  const rawPath = hashAt === -1 ? href : href.slice(0, hashAt);
  const fragment = hashAt === -1 ? null : safeDecode(href.slice(hashAt + 1));
  const relPath = safeDecode(rawPath.split('?')[0]);

  // Ссылка внутри того же документа.
  if (!relPath) {
    return internalTarget(entry, fragment, href);
  }

  const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.file), toPosix(relPath)));
  if (target.startsWith('../')) {
    return { warning: `ссылка «${href}» ведёт за пределы репозитория` };
  }

  const included = byFile.get(target);
  if (included) return internalTarget(included, fragment, href);

  const abs = path.join(repoRoot, target);
  if (!fs.existsSync(abs)) {
    return { warning: `файл «${target}» не найден — ссылка оставлена текстом` };
  }
  const isDir = fs.statSync(abs).isDirectory();
  const base = isDir ? githubBase.replace('/blob/', '/tree/') : githubBase;
  const encodedPath = target
    .replace(/\/$/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const frag = fragment ? `#${encodeURIComponent(fragment)}` : '';
  return { kind: 'repo', href: `${base}${encodedPath}${frag}` };
}

function internalTarget(entry, fragment, href) {
  if (!fragment) return { kind: 'internal', href: `#${entry.id}` };
  const id = entry.anchors.get(fragment) || entry.anchors.get(githubSlug(fragment));
  if (id) return { kind: 'internal', href: `#${id}` };
  return {
    kind: 'internal',
    href: `#${entry.id}`,
    warning: `раздел «#${fragment}» не найден в ${entry.file} — ссылка ведёт на начало документа (${safeDecode(href)})`,
  };
}
