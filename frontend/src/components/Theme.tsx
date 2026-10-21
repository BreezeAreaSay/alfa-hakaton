import corpVars from '@alfalab/core-components/vars/bundle/corp.css?inline';
import corpTheme from '@alfalab/core-components/themes/corp.css?inline';
import intranetVars from '@alfalab/core-components/vars/bundle/intranet.css?inline';
import intranetTheme from '@alfalab/core-components/themes/intranet.css?inline';

// Тема дизайн-системы задаётся переменными на :root, поэтому подключаем её стилем после компонентов:
// corp — для клиентов-юрлиц и ИП (красная главная кнопка), intranet — для сотрудников банка.
// Фирменные шрифты банка (Styrene UI, Alfa Interface Sans) распространяются по закрытой лицензии,
// поэтому все шрифтовые токены указывают на Onest (OFL 1.1) — ближайший по рисунку свободный шрифт с кириллицей.
const ONEST = `'Onest', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const FONT_OVERRIDE = `:root { --font-family: ${ONEST}; --font-family-system: ${ONEST}; --font-family-styrene: ${ONEST}; --font-family-alfasans: ${ONEST}; }`;

const THEMES = {
    corp: corpVars + corpTheme + FONT_OVERRIDE,
    intranet: intranetVars + intranetTheme + FONT_OVERRIDE,
};

export function Theme({ name }: { name: keyof typeof THEMES }) {
    return <style>{THEMES[name]}</style>;
}
