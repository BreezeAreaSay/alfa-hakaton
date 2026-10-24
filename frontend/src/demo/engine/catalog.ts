// Каталог продуктов: строки каталога — ответ /api/products настоящего сервера (fixtures/products.json),
// правила подбора — порт backend/app/domain/catalog.py.
import type { Product, Purpose } from '../../api/types';
import products from '../fixtures/products.json';

export interface ProductTerms {
    code: string;
    name: string;
    kind: string;
    description: string;
    min_amount: number;
    max_amount: number;
    min_term: number;
    max_term: number;
    base_rate: number;
    collateral_required: boolean;
    min_business_months: number;
    max_business_months: number | null;
    requires_bank_account_months: number | null;
    auto_limit: number | null;
    always_manual: boolean;
}

// Кредит под залог всегда рассматривает аналитик (в ответе API этого поля нет)
const ALWAYS_MANUAL = new Set(['SECURED']);

export const PRODUCT_ROWS = products as Product[];

export const PRODUCTS: ProductTerms[] = PRODUCT_ROWS.map((p) => ({
    code: p.code,
    name: p.name,
    kind: p.kind,
    description: p.description,
    min_amount: Number(p.min_amount),
    max_amount: Number(p.max_amount),
    min_term: p.min_term,
    max_term: p.max_term,
    base_rate: Number(p.base_rate),
    collateral_required: p.collateral_required,
    min_business_months: p.min_business_months,
    max_business_months: p.max_business_months,
    requires_bank_account_months: p.requires_bank_account_months,
    auto_limit: p.auto_limit === null ? null : Number(p.auto_limit),
    always_manual: ALWAYS_MANUAL.has(p.code),
}));

const BY_CODE = new Map(PRODUCTS.map((p) => [p.code, p]));
const ROW_BY_CODE = new Map(PRODUCT_ROWS.map((p) => [p.code, p]));

export const productTerms = (code: string): ProductTerms | undefined => BY_CODE.get(code);
export const productRow = (code: string): Product | undefined => ROW_BY_CODE.get(code);

export const PURPOSE_PRODUCTS: Record<Purpose, string[]> = {
    WORKING_CAPITAL: ['GROWTH', 'EXPRESS', 'CREDIT_LINE'],
    CASH_GAP: ['OVERDRAFT', 'CREDIT_LINE', 'EXPRESS'],
    EQUIPMENT: ['SECURED', 'GROWTH'],
    EXPANSION: ['GROWTH', 'SECURED'],
};

/** Цели, для которых продукт предназначен (как `purposes` у продукта на сервере); стартап — для всех целей. */
export function productPurposes(code: string): string[] {
    if (code === 'STARTUP') return Object.keys(PURPOSE_PRODUCTS);
    return Object.entries(PURPOSE_PRODUCTS)
        .filter(([, codes]) => codes.includes(code))
        .map(([purpose]) => purpose);
}

export const YOUNG_BUSINESS_MONTHS = 12;

export function productsForPurpose(purpose: Purpose, businessMonths: number | null): string[] {
    const codes = PURPOSE_PRODUCTS[purpose] ?? [];
    if (businessMonths !== null && businessMonths < YOUNG_BUSINESS_MONTHS) return ['STARTUP', ...codes];
    return codes;
}
