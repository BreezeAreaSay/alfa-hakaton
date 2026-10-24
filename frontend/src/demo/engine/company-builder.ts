// Конструктор тестовой компании — порт simulator/sim/companies.py (данные всех внешних систем по компактному
// описанию) и backend/app/services/companies.py (справочник ОКВЭД, логин из названия) с проверками параметров
// из backend/app/schemas.py (CompanyBuilderIn). Генерация детерминирована и совпадает с сервером: одно описание —
// одни и те же руководитель, адрес, отчётность и поступления. Снимки источников строятся на день съёмки фикстур,
// как в fixtures/companies.json, и сдвигаются к сегодняшнему дню вместе с остальными компаниями (data.ts).
import type { Company } from '../../api/types';
import { type DemoUser, uuid } from '../model';
import { monthsAgo, monthsBetween, parseDate } from './dates';
import { type Json, industryMargin, industryRisk } from './features';

export const OKVED_NAMES: Record<string, string> = {
    '25.11': 'Производство строительных металлических конструкций',
    '41.20': 'Строительство жилых и нежилых зданий',
    '46.39': 'Торговля оптовая неспециализированная пищевыми продуктами',
    '47.19': 'Торговля розничная прочая в неспециализированных магазинах',
    '49.41': 'Деятельность автомобильного грузового транспорта',
    '56.30': 'Подача напитков',
    '62.01': 'Разработка компьютерного программного обеспечения',
    '62.02': 'Деятельность консультативная в области компьютерных технологий',
    '74.10': 'Деятельность специализированная в области дизайна',
};

/** Ответ GET /api/admin/companies/options: коды по порядку, отраслевой риск и типичная рентабельность. */
export const OKVED_OPTIONS = Object.keys(OKVED_NAMES)
    .sort()
    .map((code) => ({
        code,
        name: OKVED_NAMES[code],
        industry_risk: industryRisk(code),
        typical_margin: industryMargin(code),
    }));

export interface CompanySpec {
    name: string;
    legal_form: 'OOO' | 'IP';
    registered_months_ago: number;
    okved: string;
    revenue: number;
    revenue_growth: number;
    margin: number;
    existing_monthly_payments: number;
    max_overdue_days_24m: number;
    current_overdue_days: number;
    tax_debt: number;
    mass_address: boolean;
    director_disqualified: boolean;
    company_status: 'ACTIVE' | 'LIQUIDATING';
    is_bank_client: boolean;
    account_months: number;
    avg_monthly_inflow: number;
}

/** Значения по умолчанию, как у CompanyBuilderIn: устойчивая компания. */
export const SPEC_DEFAULTS: Omit<CompanySpec, 'name'> = {
    legal_form: 'OOO',
    registered_months_ago: 72,
    okved: '46.39',
    revenue: 60_000_000,
    revenue_growth: 0.12,
    margin: 0.1,
    existing_monthly_payments: 0,
    max_overdue_days_24m: 0,
    current_overdue_days: 0,
    tax_debt: 0,
    mass_address: false,
    director_disqualified: false,
    company_status: 'ACTIVE',
    is_bank_client: true,
    account_months: 36,
    avg_monthly_inflow: 5_000_000,
};

export interface SpecIssue {
    /** Путь до поля внутри тела запроса; пустой — проверка согласованности всей модели. */
    loc: string[];
    msg: string;
}

/**
 * Проверки параметров как у CompanyBuilderIn: сначала каждое поле в порядке объявления, и только если
 * с полями всё в порядке — согласованность между ними. Возвращает описание с нормализованными значениями.
 */
export function checkCompanySpec(spec: CompanySpec): { spec: CompanySpec; issues: SpecIssue[] } {
    const issues: SpecIssue[] = [];
    const within = (field: keyof CompanySpec, value: number, low: number, high: number, msg: string) => {
        if (!(low <= value && value <= high)) issues.push({ loc: [field], msg });
    };
    const name = spec.name.split(/\s+/).filter(Boolean).join(' ');
    if (!name) issues.push({ loc: ['name'], msg: 'Укажите название компании' });
    else if (name.length > 120) issues.push({ loc: ['name'], msg: 'Название не длиннее 120 символов' });
    within('registered_months_ago', spec.registered_months_ago, 0, 600, 'Срок с регистрации — от 0 до 600 месяцев');
    if (!(spec.okved in OKVED_NAMES)) {
        issues.push({ loc: ['okved'], msg: 'Неизвестный код ОКВЭД — выберите из справочника' });
    }
    within('revenue', spec.revenue, 1, 1_000_000_000_000, 'Выручка — от 1\u00a0₽ до 1\u00a0трлн\u00a0₽');
    within(
        'revenue_growth',
        spec.revenue_growth,
        -0.9,
        10,
        'Рост выручки — доля от −0,9 до 10: например, 0,1 — рост на 10\u00a0%',
    );
    within('margin', spec.margin, -1, 1, 'Рентабельность — доля от −1 до 1: например, 0,08 — 8\u00a0%');
    within(
        'existing_monthly_payments',
        spec.existing_monthly_payments,
        0,
        1_000_000_000,
        'Платежи по кредитам — от 0 до 1\u00a0млрд\u00a0₽ в месяц',
    );
    within('max_overdue_days_24m', spec.max_overdue_days_24m, 0, 730, 'Дни просрочки — от 0 до 730');
    within('current_overdue_days', spec.current_overdue_days, 0, 730, 'Дни просрочки — от 0 до 730');
    within('tax_debt', spec.tax_debt, 0, 10_000_000_000, 'Налоговая задолженность — от 0 до 10\u00a0млрд\u00a0₽');
    within('account_months', spec.account_months, 0, 600, 'Срок счёта — от 0 до 600 месяцев');
    within(
        'avg_monthly_inflow',
        spec.avg_monthly_inflow,
        0,
        100_000_000_000,
        'Поступления на счёт — от 0 до 100\u00a0млрд\u00a0₽ в месяц',
    );
    if (issues.length) return { spec, issues };

    const normalized: CompanySpec = { ...spec, name };
    if (normalized.current_overdue_days > normalized.max_overdue_days_24m) {
        issues.push({ loc: [], msg: 'Максимальная просрочка за 24 месяца не может быть меньше текущей' });
    } else if (!normalized.is_bank_client) {
        // Не клиент банка: счёта и поступлений нет, что бы ни пришло в этих полях
        normalized.account_months = 0;
        normalized.avg_monthly_inflow = 0;
    } else if (normalized.account_months > normalized.registered_months_ago) {
        issues.push({ loc: [], msg: 'Счёт в банке не может быть открыт раньше регистрации компании' });
    } else if (normalized.avg_monthly_inflow <= 0) {
        issues.push({ loc: [], msg: 'Для клиента банка укажите среднемесячные поступления на счёт' });
    }
    return { spec: normalized, issues };
}

// ---------------------------------------------------------------- логин

const LOGIN_FALLBACK = 'company';
const LOGIN_MAX_LENGTH = 24;

// Транслитерация для логина: латиница без диакритики, как у логинов тестовых компаний (tehnomaster, altair)
const TRANSLIT: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
}; // prettier-ignore

/** Логин из названия: для ИП — фамилия, для ООО — слова названия подряд; только латиница и цифры. */
export function loginBase(name: string, legalForm: string): string {
    const words = name.split(/\s+/).filter(Boolean);
    const source = legalForm === 'IP' && words.length ? words[0] : words.join(' ');
    let latin = '';
    for (const ch of source.toLowerCase()) latin += TRANSLIT[ch] ?? ch;
    latin = latin.replace(/[^a-z0-9]/g, '');
    return (latin || LOGIN_FALLBACK).slice(0, LOGIN_MAX_LENGTH);
}

/** Свободный логин: при совпадении добавляется номер — start, start2, start3. */
export function uniqueLogin(base: string, taken: Set<string>): string {
    let login = base;
    let counter = 2;
    while (taken.has(login)) {
        login = `${base}${counter}`;
        counter += 1;
    }
    return login;
}

// ---------------------------------------------------------------- данные внешних систем (sim/companies.py)

const INN_PREFIX = '0020';
const REGION = '77';
// Номер записи в ОГРН у созданных компаний начинается с 20: у встроенных компаний номера маленькие, ОГРН не совпадают
const OGRN_SERIAL_PREFIX = '20';
const LENDER = 'Банк «Восток»';
const INFLOW_PATTERN = [0.97, 1.02, 0.95, 1.04, 1.0, 0.98, 1.03, 0.99, 1.01, 1.05, 0.96, 1.0];
const DIRECTORS = [
    'Крылова Наталья Сергеевна',
    'Фёдоров Максим Андреевич',
    'Зайцева Елена Владимировна',
    'Волков Дмитрий Олегович',
    'Тихонова Ирина Павловна',
    'Романов Алексей Викторович',
    'Мельникова Ольга Игоревна',
    'Егоров Павел Николаевич',
];
const STREETS = [
    'ул. Берёзовая',
    'Садовый проезд',
    'ул. Речная',
    'Кленовый бульвар',
    'ул. Заводская',
    'Парковая ул.',
    'ул. Полевая',
    'Солнечный переулок',
];

/** Округление половиной вверх — half_up в симуляторе (Math.round и round() в Python ведут себя иначе). */
const halfUp = (value: number): number => Math.floor(value + 0.5);

/** Сумма кодов символов — так же выбираются руководитель и адрес в симуляторе. */
function textHash(text: string): number {
    let sum = 0;
    for (const ch of text) sum += ch.codePointAt(0) ?? 0;
    return sum;
}

const checksum = (digits: number[], weights: number[]): number =>
    (weights.reduce((sum, w, i) => sum + w * digits[i], 0) % 11) % 10;

/** ИНН с верными контрольными цифрами: 10 знаков для ООО, 12 для ИП. */
export function makeInn(serial: number, legalForm: string): string {
    if (legalForm === 'OOO') {
        const body = `${INN_PREFIX}${String(serial).padStart(5, '0')}`;
        const digits = [...body].map(Number);
        return body + checksum(digits, [2, 4, 10, 3, 5, 9, 4, 6, 8]);
    }
    const body = `${INN_PREFIX}${String(serial).padStart(6, '0')}`;
    const digits = [...body].map(Number);
    const n11 = checksum(digits, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
    const n12 = checksum([...digits, n11], [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
    return `${body}${n11}${n12}`;
}

/** ОГРН (13 знаков, контроль по модулю 11) или ОГРНИП (15 знаков, по модулю 13); номер записи — префикс и serial. */
export function makeOgrn(serial: number, legalForm: string): string {
    if (legalForm === 'OOO') {
        const body = `100${REGION}${OGRN_SERIAL_PREFIX}${String(serial).padStart(5, '0')}`;
        return body + ((Number(body) % 11) % 10);
    }
    const body = `310${REGION}${OGRN_SERIAL_PREFIX}${String(serial).padStart(7, '0')}`;
    return body + ((Number(body) % 13) % 10);
}

function reportYear(offset: number, revenue: number, margin: number): Json {
    const sales = halfUp(revenue * margin);
    const net = halfUp(sales * (sales >= 0 ? 0.75 : 1.25));
    return { year_offset: offset, revenue, sales_profit: sales, net_profit: net };
}

/** Отчётность ГИР БО: только у ООО, за полный год — после года работы, за два — после двух. */
function reports(spec: CompanySpec): Json[] | null {
    if (spec.legal_form !== 'OOO' || spec.registered_months_ago < 12) return null;
    const years = [reportYear(1, spec.revenue, spec.margin)];
    if (spec.registered_months_ago >= 24) {
        years.push(reportYear(2, halfUp(spec.revenue / (1 + spec.revenue_growth)), spec.margin));
    }
    return years;
}

interface SourceSnapshot {
    status: 'DONE' | 'SKIPPED';
    result: Json;
}

/** Компания из конструктора: профиль и снимки источников на день съёмки фикстур, пользователь-руководитель. */
export interface CustomCompanyRecord {
    company: Company;
    sources: Record<string, SourceSnapshot>;
    user: DemoUser;
    created_at: string;
}

export interface BuildContext {
    /** День съёмки фикстур: даты снимка отсчитываются от него и сдвигаются к сегодняшнему дню, как у остальных. */
    capturedOn: string;
    now: number;
    /** Порядковый номер новой компании среди созданных — для ИНН и ОГРН. */
    serial: number;
    takenLogins: Set<string>;
    usedInns: Set<string>;
}

export function buildCompany(spec: CompanySpec, ctx: BuildContext): CustomCompanyRecord {
    let serial = ctx.serial;
    while (ctx.usedInns.has(makeInn(serial, spec.legal_form))) serial += 1;
    const inn = makeInn(serial, spec.legal_form);
    const ogrn = makeOgrn(serial, spec.legal_form);
    const h = textHash(spec.name);
    const isIp = spec.legal_form === 'IP';
    const name = isIp ? `ИП ${spec.name}` : `ООО «${spec.name}»`;
    const director = isIp ? spec.name : DIRECTORS[h % DIRECTORS.length];
    let address = `г. Москва, ${STREETS[h % STREETS.length]}, д. ${1 + (h % 40)}`;
    if (!isIp) address += `, офис ${1 + (h % 90)}`;
    const ago = (months: number): string => monthsAgo(months, ctx.capturedOn);
    const registered = ago(spec.registered_months_ago);

    const egrul: Json = {
        inn,
        name,
        legal_form: spec.legal_form,
        ogrn,
        registration_date: registered,
        status: spec.company_status,
        okved: spec.okved,
        okved_name: OKVED_NAMES[spec.okved] ?? spec.okved,
        address,
        director: { name: director, since: registered },
        found: true,
    };
    const fns: Json = {
        inn,
        tax_debt: spec.tax_debt,
        mass_address: spec.mass_address,
        director_disqualified: spec.director_disqualified,
        employees: Math.min(500, Math.max(1, halfUp(spec.revenue / 3_000_000))),
        tax_regime: spec.revenue > 60_000_000 ? 'ОСН' : 'УСН',
    };
    const years = reports(spec);
    const girbo: SourceSnapshot = years
        ? {
              status: 'DONE',
              result: {
                  inn,
                  available: true,
                  years: years.map((y) => ({
                      year: parseDate(ctx.capturedOn).y - y.year_offset,
                      revenue: y.revenue,
                      sales_profit: y.sales_profit,
                      net_profit: y.net_profit,
                  })),
              },
          }
        : { status: 'SKIPPED', result: { inn, available: false, years: [] } };
    const payments = spec.existing_monthly_payments;
    const bki: Json = {
        inn,
        has_history: payments > 0 || spec.max_overdue_days_24m > 0 || spec.current_overdue_days > 0,
        max_overdue_days_24m: Math.max(spec.max_overdue_days_24m, spec.current_overdue_days),
        current_overdue_days: spec.current_overdue_days,
        loans:
            payments > 0
                ? [
                      {
                          lender: LENDER,
                          kind: 'Кредит',
                          amount: payments * 36,
                          balance: payments * 20,
                          monthly_payment: payments,
                          opened_at: ago(Math.min(16, spec.registered_months_ago)),
                      },
                  ]
                : [],
    };
    let bank: SourceSnapshot = { status: 'SKIPPED', result: { inn, is_client: false, months: [] } };
    if (spec.is_bank_client) {
        const shift = h % INFLOW_PATTERN.length;
        const rotated = [...INFLOW_PATTERN.slice(shift), ...INFLOW_PATTERN.slice(0, shift)];
        const pattern = rotated.slice(rotated.length - Math.min(spec.account_months, rotated.length));
        bank = {
            status: 'DONE',
            result: {
                inn,
                is_client: true,
                account_opened_at: ago(spec.account_months),
                months: pattern.map((k, i) => ({
                    month: ago(pattern.length - i).slice(0, 7),
                    inflow: Math.round(spec.avg_monthly_inflow * k * 100) / 100,
                })),
            },
        };
    }

    const companyId = uuid();
    const opened: string | null = spec.is_bank_client ? bank.result.account_opened_at : null;
    const company: Company = {
        id: companyId,
        inn,
        name,
        legal_form: spec.legal_form,
        ogrn,
        registration_date: registered,
        okved: spec.okved,
        okved_name: egrul.okved_name,
        address,
        status: spec.company_status,
        status_label: null,
        director_name: director,
        is_bank_client: spec.is_bank_client,
        bank_account_opened_at: opened,
        business_months: monthsBetween(registered, ctx.capturedOn),
        account_months: opened ? monthsBetween(opened, ctx.capturedOn) : null,
        registry_synced_at: null,
    };
    const user: DemoUser = {
        id: uuid(),
        login: uniqueLogin(loginBase(spec.name, spec.legal_form), ctx.takenLogins),
        full_name: director,
        position: isIp ? 'Индивидуальный предприниматель' : 'Генеральный директор',
        role: 'CLIENT',
        can_sign: true,
        company_id: companyId,
    };
    return {
        company,
        sources: {
            EGRUL: { status: 'DONE', result: egrul },
            FNS: { status: 'DONE', result: fns },
            GIRBO: girbo,
            BKI: { status: 'DONE', result: bki },
            BANK: bank,
        },
        user,
        created_at: new Date(ctx.now).toISOString(),
    };
}
