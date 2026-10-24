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

// Доступность (WCAG AA: контраст текста не ниже 4,5:1). Токены переопределяются здесь, а не в global.css: тема задаёт
// их на :root позже наших стилей, а производные токены вроде --form-control-hint-color: var(--color-light-text-secondary)
// берут значение именно с :root — переопределение должно идти после темы и на том же уровне.
//  - вторичный текст: исходный rgba(4, 4, 19, 0.55) рассчитан на белый фон (4,6:1), на серых панелях #f2f3f5 даёт
//    4,4:1; плотнее — 5,3:1 на сером и 5,5:1 на белом;
//  - текст цветных статусов (Status view="muted-alt"): исходные тона на светлых подложках дают 2,2–3,5:1, затемнены
//    с сохранением оттенка до 4,6–4,7:1 (на подложках muted и на белом — 4,9–5,8:1).
const A11Y_OVERRIDE = `:root {
    --color-light-text-secondary: rgba(4, 4, 19, 0.6);
    --color-light-decorative-text-blue: #105fdb;
    --color-light-decorative-text-green: #0b772c;
    --color-light-decorative-text-indigo: #6247ee;
    --color-light-decorative-text-orange: #9a560c;
    --color-light-decorative-text-red: #c81d11;
    --color-light-decorative-text-teal: #047276;
}`;

const THEMES = {
    corp: corpVars + corpTheme + FONT_OVERRIDE + A11Y_OVERRIDE,
    intranet: intranetVars + intranetTheme + FONT_OVERRIDE + A11Y_OVERRIDE,
};

export function Theme({ name }: { name: keyof typeof THEMES }) {
    return <style>{THEMES[name]}</style>;
}
