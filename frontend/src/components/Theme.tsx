import corpVars from '@alfalab/core-components/vars/bundle/corp.css?inline';
import corpTheme from '@alfalab/core-components/themes/corp.css?inline';
import intranetVars from '@alfalab/core-components/vars/bundle/intranet.css?inline';
import intranetTheme from '@alfalab/core-components/themes/intranet.css?inline';

// Тема дизайн-системы задаётся переменными на :root, поэтому подключаем её стилем после компонентов:
// corp — для клиентов-юрлиц и ИП (красная главная кнопка), intranet — для сотрудников банка.
const FONT_OVERRIDE = `:root { --font-family-system: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; }`;

const THEMES = {
    corp: corpVars + corpTheme + FONT_OVERRIDE,
    intranet: intranetVars + intranetTheme + FONT_OVERRIDE,
};

export function Theme({ name }: { name: keyof typeof THEMES }) {
    return <style>{THEMES[name]}</style>;
}
