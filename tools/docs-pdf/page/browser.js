// Выполняется в Chromium перед печатью: шрифты, диаграммы Mermaid, подгонка таблиц.
/* global mermaid */
(() => {
  // Ниже такого масштаба на книжной странице диаграмма переносится на альбомную, если там она крупнее.
  const MIN_PORTRAIT_SCALE = 0.5;
  const LANDSCAPE_GAIN = 1.2;
  // ELK раскладывает аккуратнее (прямые углы, меньше пересечений) — берём его, если текст почти не мельче.
  const ELK_TOLERANCE = 0.88;
  // Если и так мелко — подпись: диаграмма векторная, её можно увеличить в просмотрщике.
  const ZOOM_HINT_SCALE = 0.4;

  // Тип диаграммы — первое слово после front matter и директив %%.
  function diagramType(code) {
    const lines = code.split('\n');
    let i = 0;
    if (lines[0]?.trim() === '---') {
      i = lines.findIndex((l, n) => n > 0 && l.trim() === '---') + 1;
    }
    for (; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('%%')) return line.split(/\s+/)[0];
    }
    return '';
  }

  // Варианты раскладки: dagre и ELK; у ER-диаграммы без явного direction — ещё и сверху вниз / слева направо.
  function candidates(code) {
    const type = diagramType(code);
    const layered = ['flowchart', 'graph', 'stateDiagram', 'stateDiagram-v2', 'classDiagram', 'erDiagram'];
    if (!layered.includes(type)) return [{ layout: 'dagre', code, label: type }];
    const layouts = ['elk', 'dagre'];
    if (type === 'erDiagram' && !/^\s*direction\s+(TB|TD|BT|LR|RL)\b/m.test(code)) {
      const withLR = code.replace(/^(\s*erDiagram\b.*)$/m, '$1\n    direction LR');
      return layouts.flatMap((layout) => [
        { layout, code, label: `${layout}, сверху вниз` },
        { layout, code: withLR, label: `${layout}, слева направо` },
      ]);
    }
    return layouts.map((layout) => ({ layout, code, label: layout }));
  }

  function naturalSize(svg) {
    const m = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  function fit(size, box) {
    return Math.min(1, box.width / size.width, box.maxHeight / size.height);
  }

  function choose(list) {
    const byPortrait = [...list].sort((a, b) => b.portrait - a.portrait);
    let best = byPortrait[0];
    const elk = byPortrait.find((c) => c.layout === 'elk' && c.portrait >= best.portrait * ELK_TOLERANCE);
    if (elk) best = elk;
    if (best.portrait < MIN_PORTRAIT_SCALE) {
      const wide = [...list].sort((a, b) => b.landscape - a.landscape)[0];
      if (wide.landscape >= best.portrait * LANDSCAPE_GAIN) return { ...wide, placement: 'landscape', scale: wide.landscape };
    }
    return { ...best, placement: 'portrait', scale: best.portrait };
  }

  function placeOnLandscape(figure) {
    const section = figure.closest('section.doc');
    const pageName = `${section.style.page}-wide`;
    const prev = figure.previousElementSibling;
    // Заголовок прямо над диаграммой переезжает вместе с ней, чтобы не остаться один внизу страницы.
    if (prev && /^H[2-6]$/.test(prev.tagName)) {
      const wrap = document.createElement('div');
      wrap.className = 'landscape';
      figure.before(wrap);
      wrap.append(prev, figure);
      wrap.style.page = pageName;
    } else {
      figure.style.page = pageName;
    }
    figure.classList.add('diagram--landscape');
  }

  // Mermaid оставляет в body временные элементы, если отрисовка не удалась.
  function removeMermaidLeftovers() {
    document.querySelectorAll('body > [id^="dmermaid-"]').forEach((n) => n.remove());
  }

  async function renderDiagrams({ portrait, landscape, mermaidConfig }, report) {
    const figures = [...document.querySelectorAll('figure.diagram')];
    for (const [i, figure] of figures.entries()) {
      const code = figure.querySelector('.mermaid-code').textContent;
      const body = figure.querySelector('.diagram-body');
      const source = figure.dataset.source;
      const rendered = [];
      let lastError = null;
      for (const [k, candidate] of candidates(code).entries()) {
        try {
          mermaid.initialize({ startOnLoad: false, ...mermaidConfig, layout: candidate.layout });
          const { svg } = await mermaid.render(`mermaid-${i + 1}-${k + 1}`, candidate.code);
          const size = naturalSize(svg);
          if (!size) throw new Error('у SVG нет viewBox');
          rendered.push({ ...candidate, svg, size, portrait: fit(size, portrait), landscape: fit(size, landscape) });
        } catch (error) {
          lastError = error;
        }
        removeMermaidLeftovers();
      }
      if (!rendered.length) {
        figure.classList.add('diagram--error');
        body.textContent = `Диаграмма Mermaid не отрисована: ${lastError?.message || lastError}`;
        report.diagrams.push({ source, error: String(lastError?.message || lastError) });
        continue;
      }

      const best = choose(rendered);
      body.innerHTML = best.svg;
      const el = body.querySelector('svg');
      el.removeAttribute('style');
      el.setAttribute('width', (best.size.width * best.scale).toFixed(1));
      el.setAttribute('height', (best.size.height * best.scale).toFixed(1));
      el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      if (best.placement === 'landscape') placeOnLandscape(figure);
      if (best.scale < ZOOM_HINT_SCALE) {
        const note = document.createElement('figcaption');
        note.className = 'diagram-note';
        note.textContent =
          `Диаграмма уменьшена до ${Math.round(best.scale * 100)} %, чтобы поместиться на страницу. ` +
          'Она векторная: увеличьте масштаб просмотра, чтобы прочитать подписи.';
        figure.append(note);
      }
      report.diagrams.push({
        source,
        layout: best.label,
        placement: best.placement,
        width: Math.round(best.size.width),
        height: Math.round(best.size.height),
        scale: best.scale,
      });
    }
  }

  function fitTables(report) {
    // Если таблица не помещается по ширине — мельче шрифт, затем перенос в любом месте слова.
    for (const wrap of document.querySelectorAll('.table-wrap')) {
      const table = wrap.querySelector('table');
      const steps = ['table--fit1', 'table--fit2', 'table--fit3'];
      let applied = 0;
      while (table.getBoundingClientRect().width > wrap.clientWidth + 0.5 && applied < steps.length) {
        table.classList.add(steps[applied++]);
      }
      if (applied) {
        report.tables.push({
          doc: wrap.closest('section')?.dataset.file,
          head: [...table.querySelectorAll('th')].map((th) => th.textContent.trim()).join(' | '),
          steps: applied,
          fits: table.getBoundingClientRect().width <= wrap.clientWidth + 0.5,
        });
      }
    }
  }

  function checkOverflow(report) {
    // Контроль: ничего не выходит за правое поле (альбомные страницы шире — их не проверяем).
    for (const section of document.querySelectorAll('section[data-file]')) {
      const right = section.getBoundingClientRect().right + 0.5;
      for (const el of section.querySelectorAll('p, li, pre, table, figure, blockquote, h1, h2, h3, h4, svg')) {
        if (el.closest('.diagram--landscape, .landscape')) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.right > right) {
          report.overflow.push({
            doc: section.dataset.file,
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 80),
            by: Math.round(r.right - right),
          });
        }
      }
    }
  }

  window.docsPdf = {
    async prepare(options) {
      const report = { diagrams: [], tables: [], overflow: [] };
      // Mermaid измеряет текст, поэтому все наборы символов шрифта загружаются заранее.
      await Promise.all(
        ['400', '500', '700'].map((w) => document.fonts.load(`${w} 16px Onest`, 'Аа Zz 09 ₽ → ≈')),
      );
      await document.fonts.ready;
      await renderDiagrams(options, report);
      fitTables(report);
      checkOverflow(report);
      return report;
    },

    // Номера страниц в содержании: { id: номер }.
    setPageNumbers(pages) {
      for (const el of document.querySelectorAll('.toc-page[data-target]')) {
        const n = pages[el.dataset.target];
        el.textContent = n ? String(n) : '';
      }
    },
  };
})();
