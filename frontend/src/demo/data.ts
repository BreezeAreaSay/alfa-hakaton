// Неизменяемые данные стенда из снимка настоящего API (fixtures/*.json, scripts/capture-demo-fixtures.mjs):
// справочники, пользователи, профили компаний и ответы внешних источников по каждой компании.
import type { Company, Meta } from '../api/types';
import { monthIndex, monthsAgo, monthsBetween, parseDate } from './engine/dates';
import type { Json } from './engine/features';
import agreement from './fixtures/agreement.json';
import companies from './fixtures/companies.json';
import faults from './fixtures/faults.json';
import metaJson from './fixtures/meta.json';
import users from './fixtures/users.json';
import type { DemoUser, StepCode } from './model';

export const META = metaJson as unknown as Meta;
export const DEMO_PASSWORD: string = users.password;
export const USERS = users.users as DemoUser[];
export const AGREEMENT = agreement;
export const FIXTURES_VERSION = `${users.captured_at}/${companies.captured_at}`;

/** Внешние системы симулятора в порядке /api/admin/simulator/faults. */
export const FAULT_SOURCES = faults.map((f) => ({ source: f.source, title: f.title }));

const BY_ID = new Map(USERS.map((u) => [u.id, u]));
const BY_LOGIN = new Map(USERS.map((u) => [u.login, u]));

export const userById = (id: string | null | undefined): DemoUser | undefined => (id ? BY_ID.get(id) : undefined);
export const userByLogin = (login: string): DemoUser | undefined => BY_LOGIN.get(login);
export const userName = (id: string | null | undefined): string | null => userById(id)?.full_name ?? null;

interface SourceSnapshot {
    status: 'DONE' | 'SKIPPED';
    result: Json;
}

interface CompanyFixture {
    company: Company;
    sources: Record<string, SourceSnapshot>;
}

const CAPTURED_ON: string = companies.captured_on;
const COMPANIES = Object.values(companies.companies as unknown as Record<string, CompanyFixture>);
const COMPANY_BY_ID = new Map(COMPANIES.map((c) => [c.company.id, c]));

export const companyIds = (): string[] => COMPANIES.map((c) => c.company.id);

/** Дата на снимке → та же давность относительно сегодняшнего дня (как months_ago в симуляторе). */
const shiftDate = (value: string | null | undefined, today: string): string | null =>
    value ? monthsAgo(monthIndex(CAPTURED_ON) - monthIndex(value), today) : null;

const shiftMonth = (value: string, today: string): string => shiftDate(`${value}-01`, today)!.slice(0, 7);

/**
 * Ответ внешнего источника по компании «на сегодня»: даты в снимке отсчитаны от дня съёмки,
 * поэтому сдвигаются на столько же месяцев, сколько прошло с тех пор.
 */
export function sourceSnapshot(companyId: string, code: StepCode, today: string): SourceSnapshot | null {
    const snapshot = COMPANY_BY_ID.get(companyId)?.sources[code];
    if (!snapshot) return null;
    const result: Json = structuredClone(snapshot.result);
    if (code === 'EGRUL') {
        if (result.registration_date) result.registration_date = shiftDate(result.registration_date, today);
        if (result.director?.since) result.director.since = shiftDate(result.director.since, today);
    } else if (code === 'BANK') {
        if (result.account_opened_at) result.account_opened_at = shiftDate(result.account_opened_at, today);
        result.months = (result.months ?? []).map((m: Json) => ({ ...m, month: shiftMonth(m.month, today) }));
    } else if (code === 'BKI') {
        result.loans = (result.loans ?? []).map((loan: Json) => ({
            ...loan,
            opened_at: shiftDate(loan.opened_at, today),
        }));
    } else if (code === 'GIRBO') {
        const years = parseDate(today).y - parseDate(CAPTURED_ON).y;
        result.years = (result.years ?? []).map((y: Json) => ({ ...y, year: y.year + years }));
    }
    return { status: snapshot.status, result };
}

/** Профиль компании, как его отдаёт /api/company после сверки с ЕГРЮЛ и данными банка. */
export function companyProfile(companyId: string, today: string, syncedAt: string | null): Company {
    const fixture = COMPANY_BY_ID.get(companyId);
    if (!fixture) throw new Error(`Нет компании ${companyId}`);
    const egrul = sourceSnapshot(companyId, 'EGRUL', today)?.result ?? {};
    const bank = sourceSnapshot(companyId, 'BANK', today)?.result ?? {};
    const registered: string | null = egrul.registration_date ?? null;
    const opened: string | null = bank.is_client ? (bank.account_opened_at ?? null) : null;
    const status: string | null = egrul.status ?? fixture.company.status;
    return {
        id: fixture.company.id,
        inn: fixture.company.inn,
        name: egrul.name ?? fixture.company.name,
        legal_form: egrul.legal_form ?? fixture.company.legal_form,
        ogrn: egrul.ogrn ?? fixture.company.ogrn,
        registration_date: registered,
        okved: egrul.okved ?? fixture.company.okved,
        okved_name: egrul.okved_name ?? fixture.company.okved_name,
        address: egrul.address ?? fixture.company.address,
        status,
        status_label: META.company_statuses[status ?? ''] ?? null,
        director_name: egrul.director?.name ?? fixture.company.director_name,
        is_bank_client: Boolean(bank.is_client),
        bank_account_opened_at: opened,
        business_months: registered ? monthsBetween(registered, today) : null,
        account_months: opened ? monthsBetween(opened, today) : null,
        registry_synced_at: syncedAt,
    };
}
