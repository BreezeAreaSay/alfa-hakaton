import { Button } from '@alfalab/core-components/button';
import { Checkbox } from '@alfalab/core-components/checkbox';
import { Input } from '@alfalab/core-components/input';
import { Plate } from '@alfalab/core-components/plate';
import { Select } from '@alfalab/core-components/select';
import { SliderInput } from '@alfalab/core-components/slider-input';
import { Steps } from '@alfalab/core-components/steps';
import { Textarea } from '@alfalab/core-components/textarea';
import { Typography } from '@alfalab/core-components/typography';
import { BanknoteStackMIcon } from '@alfalab/icons-glyph/BanknoteStackMIcon';
import { BriefcaseGearMIcon } from '@alfalab/icons-glyph/BriefcaseGearMIcon';
import { ChartLineAscMIcon } from '@alfalab/icons-glyph/ChartLineAscMIcon';
import { BrushMIcon } from '@alfalab/icons-glyph/BrushMIcon';
import { ClockCoinMIcon } from '@alfalab/icons-glyph/ClockCoinMIcon';
import { DocumentPercentMIcon } from '@alfalab/icons-glyph/DocumentPercentMIcon';
import { InformationCircleMIcon } from '@alfalab/icons-glyph/InformationCircleMIcon';
import { MagicWandMIcon } from '@alfalab/icons-glyph/MagicWandMIcon';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { newIdempotencyKey } from '../../api/client';
import {
    useApplication,
    useCompany,
    useCreateDraft,
    useDeleteDocument,
    useParseNeed,
    useQuote,
    useSubmit,
    useUpdateDraft,
    useUpload,
} from '../../api/hooks';
import type { Application, Company, ParsedNeed, Purpose, QuoteItem } from '../../api/types';
import { Badge, ErrorPlate, KeyValue, Loader, PageHead } from '../../components/ui';
// Разбор на правилах — тот же, что на сервере (backend/app/services/ai.py): по нему показываем, на каких словах основан вывод
import { explainNeed, type NeedEvidence, parseNeedRules } from '../../demo/engine/ai';
import { months, num, percent, rub, shortAmount } from '../../utils/format';
import { CompanyCard } from './components/CompanyCard';
import { DocumentList } from './components/DocumentList';
import { UploadButton } from './components/UploadButton';

const STEP_TITLES = ['Подбор продукта', 'Данные заявки', 'Проверка и отправка'];

/**
 * Задачи бизнеса — главный вход в подбор: клиент мыслит задачей, а не продуктом. Задач больше, чем целей
 * кредита на сервере (Purpose): ремонт — это расширение, налоги и зарплата — кассовый разрыв.
 * hints — слова, по которым из описания своими словами выбирается задача внутри одной цели.
 */
type Task = { key: string; purpose: Purpose; title: string; icon: ReactNode; hints?: string[] };

const TASKS: Task[] = [
    {
        key: 'stock',
        purpose: 'WORKING_CAPITAL',
        title: 'Закупка товара',
        icon: <BanknoteStackMIcon aria-hidden={true} />,
    },
    {
        key: 'equipment',
        purpose: 'EQUIPMENT',
        title: 'Оборудование',
        icon: <BriefcaseGearMIcon aria-hidden={true} />,
    },
    {
        key: 'gap',
        purpose: 'CASH_GAP',
        title: 'Кассовый разрыв',
        icon: <ClockCoinMIcon aria-hidden={true} />,
    },
    {
        key: 'expansion',
        purpose: 'EXPANSION',
        title: 'Расширение',
        icon: <ChartLineAscMIcon aria-hidden={true} />,
    },
    {
        key: 'repair',
        purpose: 'EXPANSION',
        title: 'Ремонт помещения',
        icon: <BrushMIcon aria-hidden={true} />,
        hints: ['ремонт'],
    },
    {
        key: 'taxes',
        purpose: 'CASH_GAP',
        title: 'Налоги и зарплата',
        icon: <DocumentPercentMIcon aria-hidden={true} />,
        hints: ['налог', 'зарплат'],
    },
];

function taskFor(purpose: Purpose, text = ''): Task {
    const lowered = text.toLowerCase();
    const candidates = TASKS.filter((task) => task.purpose === purpose);
    return candidates.find((task) => task.hints?.some((hint) => lowered.includes(hint))) ?? candidates[0];
}

/**
 * Почему продукт подходит под цель и какие похожие продукты не подойдут. Только факты каталога
 * (backend/app/domain/catalog.py): суммы, сроки, залог. Набор продуктов по цели — PURPOSE_PRODUCTS там же.
 */
const PURPOSE_ADVICE: Record<Purpose, { why: Record<string, string>; not: { name: string; reason: string }[] }> = {
    WORKING_CAPITAL: {
        why: {
            GROWTH: 'Без залога, срок до 5 лет — закупку можно вернуть из выручки по частям',
            EXPRESS: 'Быстрое решение без залога, если закупка небольшая — до 5 млн ₽',
            CREDIT_LINE: 'Закупаетесь регулярно — берёте деньги частями, проценты только на использованную часть',
        },
        not: [
            {
                name: 'Овердрафт',
                reason: 'лимит даётся на год и рассчитан на короткие разрывы — закупку с возвратом за несколько лет он не закроет',
            },
            { name: 'Кредит под залог', reason: 'для крупных вложений на годы — для закупки товара залог не нужен' },
        ],
    },
    CASH_GAP: {
        why: {
            OVERDRAFT: 'Проценты только за дни, когда пользуетесь деньгами, — удобно для разрыва на дни и недели',
            CREDIT_LINE: 'Разрывы повторяются — берёте нужную часть лимита, когда понадобится',
            EXPRESS: 'Разовая сумма, если разрыв затянулся, — вернёте по графику до 3 лет',
        },
        not: [
            {
                name: 'Кредит на развитие',
                reason: 'от 1 млн ₽ и от года — для разрыва в несколько недель переплатите за деньги, которые лежат без дела',
            },
            { name: 'Кредит под залог', reason: 'оформление с оценкой залога дольше, чем длится разрыв' },
        ],
    },
    EQUIPMENT: {
        why: {
            SECURED: 'Ставка ниже за счёт залога, срок до 10 лет — в залог можно оставить само оборудование',
            GROWTH: 'Без залога, срок до 5 лет — если оборудование стоит до 30 млн ₽',
        },
        not: [
            { name: 'Овердрафт', reason: 'лимит на год для текущих платежей — оборудование окупается дольше' },
            {
                name: 'Кредитная линия',
                reason: 'для оборотных нужд на 1–2 года, а не для покупки оборудования',
            },
        ],
    },
    EXPANSION: {
        why: {
            GROWTH: 'Без залога, срок до 5 лет — новая точка успеет выйти на окупаемость',
            SECURED: 'Сумма до 150 млн ₽ по ставке ниже, если есть что оставить в залог',
        },
        not: [
            { name: 'Овердрафт', reason: 'лимит на год для текущих платежей — расширение окупается дольше' },
            { name: 'Экспресс-кредит', reason: 'до 5 млн ₽ и до 3 лет — для новой точки или ремонта обычно мало' },
        ],
    },
};

const STARTUP_WHY = 'Единственный продукт для бизнеса младше года';

const COLLATERAL_TYPES = ['Коммерческая недвижимость', 'Жилая недвижимость', 'Транспорт', 'Оборудование'].map((v) => ({
    key: v,
    content: v,
}));

const MIN_AMOUNT = 100_000;
const MAX_AMOUNT = 30_000_000;

function useDebounced<T>(value: T, delay = 350): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return debounced;
}

/**
 * У SliderInput дизайн-системы ползунок — <div role="slider"> от noUiSlider без доступного имени, а пропса,
 * чтобы его подписать, нет. Подписываем сами после монтирования: имя берём из data-slider-label обёртки.
 * Эффект без зависимостей выполняется после каждого рендера, но это два обращения к DOM.
 */
function LabelledSlider({ label, children }: { label: string; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        ref.current?.querySelectorAll('.noUi-handle').forEach((handle) => handle.setAttribute('aria-label', label));
    });
    return (
        <div ref={ref} data-slider-label={label}>
            {children}
        </div>
    );
}

const toNumber = (value: string): number | null => {
    const digits = value.replace(/[^\d]/g, '');
    return digits ? Number(digits) : null;
};

const formatDigits = (value: number | null): string => (value ? new Intl.NumberFormat('ru-RU').format(value) : '');

const isPurpose = (value: string | null): value is Purpose => TASKS.some((task) => task.purpose === value);

export function NewApplicationPage() {
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const draftId = params.get('draft');
    const draft = useApplication(draftId ?? undefined);
    const company = useCompany();

    const [step, setStep] = useState(0);
    // Предварительное предложение с главной передаёт цель, сумму и срок в адресе
    const [purpose, setPurpose] = useState<Purpose>(() => {
        const value = params.get('purpose');
        return isPurpose(value) ? value : 'WORKING_CAPITAL';
    });
    const [amount, setAmount] = useState<number>(() => Number(params.get('amount')) || 3_000_000);
    const [term, setTerm] = useState<number>(() => Number(params.get('term')) || 24);
    const [productCode, setProductCode] = useState<string | null>(null);
    const [aiParsed, setAiParsed] = useState<ParsedNeed | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        if (!draft.data || initialized.current) return;
        initialized.current = true;
        if (draft.data.status !== 'DRAFT') {
            navigate(`/client/applications/${draft.data.id}`, { replace: true });
            return;
        }
        setPurpose(draft.data.purpose);
        setAmount(num(draft.data.amount));
        setTerm(draft.data.term_months);
        setProductCode(draft.data.product.code);
        setStep(1);
    }, [draft.data, navigate]);

    if (draftId && draft.isLoading) return <Loader />;

    return (
        <main className='page'>
            <PageHead
                title='Заявка на кредит для бизнеса'
                subtitle='Подберём продукт под задачу, данные компании подтянем из ЕГРЮЛ — заполнять почти ничего не нужно'
            />
            <div className='card card--tight steps-card' style={{ marginBottom: 24 }}>
                <div className='steps-card__full'>
                    <Steps activeStep={step + 1} isMarkCompletedSteps={true} ordered={true} interactive={false}>
                        {STEP_TITLES.map((title) => (
                            <span key={title}>{title}</span>
                        ))}
                    </Steps>
                </div>
                {/* на телефоне горизонтальные шаги не помещаются — компактный индикатор */}
                <div className='steps-card__compact' aria-label={`Шаг ${step + 1} из ${STEP_TITLES.length}`}>
                    <Typography.Text view='primary-small' color='secondary' tag='div'>
                        Шаг {step + 1} из {STEP_TITLES.length}
                    </Typography.Text>
                    <Typography.Text view='primary-medium' weight='bold' tag='div'>
                        {STEP_TITLES[step]}
                    </Typography.Text>
                    <div className='steps-card__bar'>
                        <span style={{ width: `${((step + 1) / STEP_TITLES.length) * 100}%` }} />
                    </div>
                </div>
            </div>
            {step === 0 && (
                <SelectionStep
                    company={company.data}
                    purpose={purpose}
                    amount={amount}
                    term={term}
                    onPurpose={setPurpose}
                    onAmount={setAmount}
                    onTerm={setTerm}
                    aiParsed={aiParsed}
                    onAiParsed={setAiParsed}
                    draft={draft.data}
                    onChosen={(application) => {
                        setProductCode(application.product.code);
                        setParams({ draft: application.id }, { replace: true });
                        initialized.current = true;
                        setStep(1);
                    }}
                />
            )}
            {step === 1 && draft.data && company.data && (
                <DetailsStep
                    application={draft.data}
                    company={company.data}
                    onBack={() => setStep(0)}
                    onNext={() => setStep(2)}
                />
            )}
            {step === 2 && draft.data && <ReviewStep application={draft.data} onBack={() => setStep(1)} />}
            {step > 0 && !draft.data && productCode && <Loader />}
        </main>
    );
}

// ---------------------------------------------------------------- шаг 1: подбор

function SelectionStep({
    company,
    purpose,
    amount,
    term,
    onPurpose,
    onAmount,
    onTerm,
    aiParsed,
    onAiParsed,
    draft,
    onChosen,
}: {
    company: Company | undefined;
    purpose: Purpose;
    amount: number;
    term: number;
    onPurpose: (p: Purpose) => void;
    onAmount: (v: number) => void;
    onTerm: (v: number) => void;
    aiParsed: ParsedNeed | null;
    onAiParsed: (p: ParsedNeed | null) => void;
    draft: Application | undefined;
    onChosen: (application: Application) => void;
}) {
    const [need, setNeed] = useState('');
    const [task, setTask] = useState(() => taskFor(purpose).key);
    const [showText, setShowText] = useState(false);
    // Что дал разбор на правилах и по каким словам — для блока «Я понял так»
    const [understood, setUnderstood] = useState<{ rules: ParsedNeed; evidence: NeedEvidence } | null>(null);
    const [missing, setMissing] = useState({ amount: false, term: false });
    const tasksRef = useRef<HTMLDivElement>(null);
    const amountRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<HTMLDivElement>(null);
    const parse = useParseNeed();
    const create = useCreateDraft();
    const update = useUpdateDraft();
    const debouncedAmount = useDebounced(amount);
    const debouncedTerm = useDebounced(term);

    const quoteParams = useMemo(
        () =>
            company
                ? {
                      purpose,
                      amount: Math.max(debouncedAmount, 10_000),
                      term_months: Math.max(debouncedTerm, 1),
                      legal_form: company.legal_form,
                      business_months: company.business_months,
                      is_bank_client: company.is_bank_client,
                      account_months: company.account_months ?? 0,
                  }
                : null,
        [company, purpose, debouncedAmount, debouncedTerm],
    );
    const quote = useQuote(quoteParams);

    const pickTask = (next: Task) => {
        setTask(next.key);
        onPurpose(next.purpose);
    };
    const changeAmount = (value: number) => {
        setMissing((current) => ({ ...current, amount: false }));
        onAmount(value);
    };
    const changeTerm = (value: number) => {
        setMissing((current) => ({ ...current, term: false }));
        onTerm(value);
    };

    const runParse = async () => {
        const result = await parse.mutateAsync(need);
        onAiParsed(result);
        setUnderstood({ rules: parseNeedRules(need), evidence: explainNeed(need) });
        if (result.purpose) pickTask(taskFor(result.purpose, need));
        if (result.amount) onAmount(result.amount);
        if (result.term_months) onTerm(result.term_months);
        // Чего нет в тексте — не угадываем: просим указать
        setMissing({ amount: !result.amount, term: !result.term_months });
    };

    // «Изменить» в блоке «Я понял так»: прокрутить к полю и поставить в него фокус
    const focusField = (ref: React.RefObject<HTMLDivElement | null>) => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ref.current?.querySelector<HTMLElement>('[aria-pressed="true"], input')?.focus({ preventScroll: true });
    };

    const currentTask = TASKS.find((item) => item.key === task) ?? taskFor(purpose);
    // В «не подойдёт» — продукты, которых нет в PURPOSE_PRODUCTS для этой цели, поэтому со списком подбора они не пересекаются
    const advice = PURPOSE_ADVICE[purpose];

    const choose = async (item: QuoteItem) => {
        const product = item.product;
        const clampedAmount = Math.min(Math.max(amount, num(product.min_amount)), num(product.max_amount));
        const clampedTerm = Math.min(Math.max(term, product.min_term), product.max_term);
        const body = {
            product_code: product.code,
            purpose,
            amount: clampedAmount,
            term_months: clampedTerm,
            // Без описания своими словами цель заявки — название задачи: на шаге «Данные» её можно уточнить
            purpose_text: aiParsed?.summary ?? (need.trim() || currentTask.title),
            ai_parsed: aiParsed ? { ...aiParsed, text: need } : null,
        };
        const application = draft
            ? await update.mutateAsync({ id: draft.id, ...body })
            : await create.mutateAsync(body);
        onChosen(application);
    };

    const facts = company
        ? [
              company.legal_form === 'IP' ? 'ИП' : 'ООО',
              company.business_months !== null ? `бизнесу ${months(company.business_months)}` : null,
              company.is_bank_client ? 'есть счёт в банке' : 'нет счёта в банке',
          ].filter(Boolean)
        : [];

    return (
        // Как калькулятор на alfabank.ru: одна серая панель, слева параметры, справа белые карточки продуктов
        <section className='card stack'>
            <Typography.Title tag='h2' view='medium' font='system' weight='bold'>
                Рассчитаем кредит под вашу задачу
            </Typography.Title>
            <div className='grid-2 grid-2--calculator'>
                <div className='stack'>
                    <div className='stack-8' ref={tasksRef}>
                        <Typography.Text view='primary-medium' color='secondary'>
                            На что нужны деньги
                        </Typography.Text>
                        <div className='purpose-grid'>
                            {TASKS.map((item) => (
                                <button
                                    key={item.key}
                                    type='button'
                                    className={`purpose${task === item.key ? ' purpose--active' : ''}`}
                                    onClick={() => pickTask(item)}
                                    aria-pressed={task === item.key}
                                >
                                    <span className='purpose__icon'>{item.icon}</span>
                                    <Typography.Text view='primary-small' weight='bold'>
                                        {item.title}
                                    </Typography.Text>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Описание своими словами — второй, необязательный путь: спрос на него пока не подтверждён */}
                    {showText ? (
                        <div className='tile stack-16'>
                            <Typography.Text view='primary-medium' weight='medium' tag='div'>
                                Опишите задачу своими словами
                            </Typography.Text>
                            <Textarea
                                label='Ваша задача'
                                aria-label='Ваша задача'
                                labelView='inner'
                                size={56}
                                block={true}
                                minRows={2}
                                maxLength={500}
                                value={need}
                                onChange={(e) => setNeed(e.target.value)}
                                hint='Например: нужно закупить товар к сезону на 3 млн, верну за полгода'
                            />
                            <div className='row'>
                                <Button
                                    view='secondary'
                                    size={40}
                                    leftAddons={<MagicWandMIcon aria-hidden={true} />}
                                    onClick={runParse}
                                    loading={parse.isPending}
                                    disabled={need.trim().length < 3}
                                >
                                    Подобрать по описанию
                                </Button>
                            </div>
                            <ErrorPlate error={parse.error} />
                            {aiParsed && understood && (
                                <Understood
                                    parsed={aiParsed}
                                    rules={understood.rules}
                                    evidence={understood.evidence}
                                    taskTitle={aiParsed.purpose ? taskFor(aiParsed.purpose, need).title : null}
                                    onEditTask={() => focusField(tasksRef)}
                                    onEditAmount={() => focusField(amountRef)}
                                    onEditTerm={() => focusField(termRef)}
                                />
                            )}
                        </div>
                    ) : (
                        <div>
                            <Button
                                view='text'
                                size={32}
                                leftAddons={<MagicWandMIcon aria-hidden={true} />}
                                onClick={() => setShowText(true)}
                            >
                                Или опишите задачу своими словами
                            </Button>
                        </div>
                    )}

                    <div ref={amountRef}>
                        <LabelledSlider label='Сумма кредита'>
                            <SliderInput
                                label='Сумма кредита'
                                labelView='inner'
                                size={56}
                                block={true}
                                hint={missing.amount ? 'В описании суммы не было — укажите, сколько нужно' : undefined}
                                value={formatDigits(amount)}
                                sliderValue={Math.min(Math.max(amount, MIN_AMOUNT), MAX_AMOUNT)}
                                min={MIN_AMOUNT}
                                max={MAX_AMOUNT}
                                step={50_000}
                                rightAddons={
                                    <Typography.Text view='primary-medium' color='secondary'>
                                        ₽
                                    </Typography.Text>
                                }
                                pips={{
                                    mode: 'values',
                                    values: [MIN_AMOUNT, 15_000_000, MAX_AMOUNT],
                                    format: { to: shortAmount },
                                }}
                                onChange={(_, payload) => {
                                    const value =
                                        typeof payload.value === 'number'
                                            ? payload.value
                                            : toNumber(String(payload.value));
                                    changeAmount(value ?? 0);
                                }}
                            />
                        </LabelledSlider>
                    </div>
                    <div ref={termRef}>
                        <LabelledSlider label='Срок'>
                            <SliderInput
                                label='Срок'
                                labelView='inner'
                                size={56}
                                block={true}
                                hint={
                                    missing.term
                                        ? 'В описании срока не было — укажите, за сколько планируете вернуть'
                                        : undefined
                                }
                                value={months(term)}
                                sliderValue={term}
                                min={6}
                                max={120}
                                step={6}
                                pips={{
                                    mode: 'values',
                                    values: [6, 60, 120],
                                    format: { to: (v: number) => months(v) },
                                }}
                                onChange={(_, payload) => {
                                    if (typeof payload.value === 'number') changeTerm(payload.value);
                                }}
                            />
                        </LabelledSlider>
                    </div>
                    {company && (
                        <Plate
                            view='common'
                            rounded={true}
                            leftAddons={
                                <InformationCircleMIcon color='var(--color-light-status-info)' aria-hidden={true} />
                            }
                            limitContentWidth={false}
                            title={facts.join(' · ')}
                        >
                            Подставили из ЕГРЮЛ и данных банка — от этого зависят доступные продукты.
                        </Plate>
                    )}
                </div>

                <section className='stack-16' aria-label='Подходящие продукты'>
                    {quote.isLoading && <Loader text='Подбираем продукты…' />}
                    <ErrorPlate error={quote.error ?? create.error ?? update.error} />
                    {quote.data?.map((item, index) => (
                        <QuoteCard
                            key={item.product.code}
                            item={item}
                            // Продукты идут от меньшей ставки: первый подходящий — самый дешёвый, если есть выбор
                            cheapest={
                                index === 0 && item.eligible && (quote.data?.filter((i) => i.eligible).length ?? 0) > 1
                            }
                            why={item.product.code === 'STARTUP' ? STARTUP_WHY : advice.why[item.product.code]}
                            onChoose={() => void choose(item)}
                            busy={create.isPending || update.isPending}
                        />
                    ))}
                    {quote.data && (
                        <div className='tile stack-8'>
                            <Typography.Text view='primary-medium' weight='bold' tag='div'>
                                Не подойдёт для задачи «{currentTask.title.toLowerCase()}»
                            </Typography.Text>
                            {advice.not.map((item) => (
                                <Typography.Text key={item.name} view='primary-small' tag='p'>
                                    <b>{item.name}:</b> {item.reason}
                                </Typography.Text>
                            ))}
                        </div>
                    )}
                    <Typography.Text view='primary-small' color='secondary' tag='p'>
                        Расчёт предварительный, по базовой ставке. Точные условия — после проверки заявки.
                    </Typography.Text>
                </section>
            </div>
        </section>
    );
}

/**
 * «Я понял так»: что разбор нашёл в описании и по каким словам. Чего в тексте нет — не угадываем, а просим
 * указать. Слова показываем, только если значение совпало с разбором на правилах; иначе его дала модель.
 */
function Understood({
    parsed,
    rules,
    evidence,
    taskTitle,
    onEditTask,
    onEditAmount,
    onEditTerm,
}: {
    parsed: ParsedNeed;
    rules: ParsedNeed;
    evidence: NeedEvidence;
    taskTitle: string | null;
    onEditTask: () => void;
    onEditAmount: () => void;
    onEditTerm: () => void;
}) {
    const basis = (sameAsRules: boolean, words: (string | null)[]) => {
        const found = words.filter((word): word is string => Boolean(word));
        if (!sameAsRules) return 'по оценке модели';
        return found.length ? `по словам: ${found.map((word) => `«${word}»`).join(', ')}` : null;
    };
    const rows = [
        {
            label: 'Задача',
            value: taskTitle,
            basis: basis(parsed.purpose === rules.purpose, evidence.purpose),
            missing: 'не определили — выберите выше',
            onEdit: onEditTask,
        },
        {
            label: 'Сумма',
            value: parsed.amount ? rub(parsed.amount) : null,
            basis: basis(parsed.amount === rules.amount, [evidence.amount]),
            missing: 'в тексте не нашли — укажите ниже',
            onEdit: onEditAmount,
        },
        {
            label: 'Срок',
            value: parsed.term_months ? months(parsed.term_months) : null,
            basis: basis(parsed.term_months === rules.term_months, [evidence.term]),
            missing: 'в тексте не нашли — укажите ниже',
            onEdit: onEditTerm,
        },
    ];
    return (
        <div className='understood stack-8' role='status'>
            <Typography.Text view='primary-medium' weight='bold' tag='div'>
                Я понял так
            </Typography.Text>
            {rows.map((row) => (
                <div key={row.label} className='understood__row'>
                    <Typography.Text view='primary-small' color='secondary' tag='div' className='understood__label'>
                        {row.label}
                    </Typography.Text>
                    <div>
                        {row.value ? (
                            <Typography.Text view='primary-small' weight='bold' tag='div'>
                                {row.value}
                            </Typography.Text>
                        ) : (
                            <Typography.Text view='primary-small' color='attention' tag='div'>
                                {row.missing}
                            </Typography.Text>
                        )}
                        {row.value && row.basis && (
                            <Typography.Text view='primary-small' color='secondary' tag='div'>
                                {row.basis}
                            </Typography.Text>
                        )}
                    </div>
                    <Button view='text' size={32} onClick={row.onEdit}>
                        Изменить
                    </Button>
                </div>
            ))}
            <Typography.Text view='primary-small' color='secondary' tag='p'>
                Верно? Если нет — поправьте: заявку оформим по значениям в полях ниже.
            </Typography.Text>
        </div>
    );
}

function QuoteCard({
    item,
    cheapest = false,
    why,
    onChoose,
    busy,
}: {
    item: QuoteItem;
    cheapest?: boolean;
    /** Почему продукт подходит под выбранную задачу */
    why?: string;
    onChoose: () => void;
    busy: boolean;
}) {
    const product = item.product;
    return (
        <article className={`offer-card stack-16${item.eligible ? '' : ' offer-card--disabled'}`}>
            <div className='row row--between' style={{ alignItems: 'flex-start' }}>
                <div className='stack-8' style={{ flex: 1 }}>
                    <div className='row' style={{ gap: 8 }}>
                        <Typography.Title tag='h3' view='small' font='system' weight='bold'>
                            {product.name}
                        </Typography.Title>
                        {cheapest && <Badge color='green'>самая низкая ставка</Badge>}
                    </div>
                    <Typography.Text view='primary-small' color='secondary' tag='p'>
                        {product.description}
                    </Typography.Text>
                    {why && item.eligible && (
                        <Typography.Text view='primary-small' tag='p'>
                            <b>Почему подходит:</b> {why}
                        </Typography.Text>
                    )}
                </div>
            </div>
            <div className='metrics'>
                <div>
                    <div className='metric__label'>Ставка</div>
                    <div className='metric__value'>от {percent(item.rate_from)}</div>
                </div>
                <div>
                    <div className='metric__label'>{item.payment_label}</div>
                    <div className='metric__value'>{rub(item.monthly_payment)}</div>
                </div>
                <div>
                    <div className='metric__label'>Переплата</div>
                    <div className='metric__value'>{rub(item.overpayment)}</div>
                </div>
            </div>
            <Typography.Text view='primary-small' color='secondary' tag='div'>
                {rub(product.min_amount)} – {rub(product.max_amount)} ·{' '}
                {product.min_term === product.max_term
                    ? months(product.min_term)
                    : `${months(product.min_term)} – ${months(product.max_term)}`}
                {product.collateral_required ? ' · нужен залог' : ' · без залога'}
            </Typography.Text>
            {!item.eligible && (
                <Plate view='attention' rounded={true} limitContentWidth={false} title='Сейчас недоступен'>
                    {item.issues.join('. ')}
                </Plate>
            )}
            <div className='row'>
                <Button view='primary' size={48} onClick={onChoose} disabled={!item.eligible} loading={busy}>
                    Оформить заявку
                </Button>
            </div>
        </article>
    );
}

// ---------------------------------------------------------------- шаг 2: данные заявки

function DetailsStep({
    application,
    company,
    onBack,
    onNext,
}: {
    application: Application;
    company: Company;
    onBack: () => void;
    onNext: () => void;
}) {
    const update = useUpdateDraft();
    const upload = useUpload();
    const deleteDocument = useDeleteDocument();
    const [purposeText, setPurposeText] = useState(application.purpose_text ?? '');
    const [revenue, setRevenue] = useState<number | null>(
        application.declared_revenue ? num(application.declared_revenue) : null,
    );
    const [collateralType, setCollateralType] = useState<string | null>(application.collateral_type);
    const [collateralValue, setCollateralValue] = useState<number | null>(
        application.collateral_value ? num(application.collateral_value) : null,
    );
    const [showErrors, setShowErrors] = useState(false);

    const needsCollateral = application.product.collateral_required;
    const errors = {
        purpose: purposeText.trim().length < 5 ? 'Опишите цель хотя бы в нескольких словах' : undefined,
        revenue: !revenue ? 'Укажите выручку за последний год' : undefined,
        collateral:
            needsCollateral && (!collateralType || !collateralValue) ? 'Укажите залог и его стоимость' : undefined,
    };

    const save = async () => {
        await update.mutateAsync({
            id: application.id,
            purpose_text: purposeText.trim(),
            declared_revenue: revenue,
            collateral_type: needsCollateral ? collateralType : null,
            collateral_value: needsCollateral ? collateralValue : null,
        });
    };

    const next = async () => {
        setShowErrors(true);
        if (errors.purpose || errors.revenue || errors.collateral) return;
        await save();
        onNext();
    };

    const statementDocs = application.documents.filter((d) => d.kind === 'BANK_STATEMENT');
    const otherDocs = application.documents.filter((d) => d.kind !== 'BANK_STATEMENT');

    return (
        <div className='grid-2'>
            <div className='stack'>
                <CompanyCard company={company} refreshable={true} />
                <section className='card stack'>
                    <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                        О кредите
                    </Typography.Title>
                    <Textarea
                        label='Цель кредита'
                        aria-label='Цель кредита'
                        labelView='inner'
                        size={56}
                        block={true}
                        minRows={3}
                        maxLength={500}
                        showCounter={true}
                        value={purposeText}
                        onChange={(e) => setPurposeText(e.target.value)}
                        error={showErrors ? errors.purpose : undefined}
                        hint='Например: закупка партии товара к новогоднему сезону'
                    />
                    <Input
                        label='Выручка за последний год, по вашим данным'
                        labelView='inner'
                        size={56}
                        block={true}
                        value={formatDigits(revenue)}
                        onChange={(e) => setRevenue(toNumber(e.target.value))}
                        rightAddons={
                            <Typography.Text view='primary-medium' color='secondary'>
                                ₽
                            </Typography.Text>
                        }
                        error={showErrors ? errors.revenue : undefined}
                        hint='Сверим с данными ФНС и оборотами по счёту'
                        inputMode='numeric'
                    />
                    {needsCollateral && (
                        <div className='stack-16'>
                            <Select
                                label='Что в залоге'
                                labelView='inner'
                                size={56}
                                block={true}
                                options={COLLATERAL_TYPES}
                                selected={collateralType}
                                onChange={({ selected }) => setCollateralType(selected?.key ?? null)}
                                error={showErrors && !collateralType ? errors.collateral : undefined}
                            />
                            <Input
                                label='Оценочная стоимость залога'
                                labelView='inner'
                                size={56}
                                block={true}
                                value={formatDigits(collateralValue)}
                                onChange={(e) => setCollateralValue(toNumber(e.target.value))}
                                rightAddons={
                                    <Typography.Text view='primary-medium' color='secondary'>
                                        ₽
                                    </Typography.Text>
                                }
                                error={showErrors && !collateralValue ? errors.collateral : undefined}
                                hint='Сумма кредита — до 80% стоимости залога'
                                inputMode='numeric'
                            />
                        </div>
                    )}
                </section>

                <section className='card stack-16'>
                    <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                        Документы
                    </Typography.Title>
                    {!company.is_bank_client || (company.account_months ?? 0) < 3 ? (
                        <Plate
                            view='common'
                            rounded={true}
                            limitContentWidth={false}
                            title='Приложите выписку по счёту за 12 месяцев'
                        >
                            Из другого банка, в формате 1С (.txt) или CSV — по ней оценим выручку, если её не подтвердит
                            отчётность, и построим прогноз денежного потока. Без выписки банк запросит её после
                            проверки.{' '}
                            <a href={`${import.meta.env.BASE_URL}demo-files/vypiska_orlov_1c.txt`} download={true}>
                                Тестовая выписка
                            </a>
                        </Plate>
                    ) : (
                        <Typography.Text view='primary-medium' color='secondary' tag='p'>
                            Обороты по счёту в банке возьмём сами, выписка не обязательна. Но по выписке из другого
                            банка (1С или CSV) мы построим прогноз денежного потока на три месяца и подскажем лимит
                            овердрафта под кассовый разрыв.{' '}
                            <a href={`${import.meta.env.BASE_URL}demo-files/vypiska_smirnova.csv`} download={true}>
                                Тестовая выписка с кассовым разрывом
                            </a>
                        </Typography.Text>
                    )}
                    <DocumentList documents={statementDocs} onDelete={(doc) => deleteDocument.mutate(doc.id)} />
                    <DocumentList documents={otherDocs} onDelete={(doc) => deleteDocument.mutate(doc.id)} />
                    <div className='row'>
                        <UploadButton
                            accept='.txt,.csv'
                            loading={upload.isPending && upload.variables?.kind === 'BANK_STATEMENT'}
                            onFile={(file) => upload.mutate({ id: application.id, file, kind: 'BANK_STATEMENT' })}
                        >
                            Прикрепить выписку
                        </UploadButton>
                        <UploadButton
                            loading={upload.isPending && upload.variables?.kind === 'OTHER'}
                            onFile={(file) => upload.mutate({ id: application.id, file, kind: 'OTHER' })}
                        >
                            Другой документ
                        </UploadButton>
                    </div>
                    <ErrorPlate error={upload.error} title='Файл не загружен' />
                </section>
            </div>

            <aside className='card sticky stack-16'>
                <Summary application={application} />
                <ErrorPlate error={update.error} />
                <Button view='primary' size={56} block={true} onClick={next} loading={update.isPending}>
                    Далее
                </Button>
                <Button view='secondary' size={56} block={true} onClick={onBack}>
                    Изменить продукт или сумму
                </Button>
            </aside>
        </div>
    );
}

function Summary({ application }: { application: Application }) {
    const product = application.product;
    return (
        <div className='stack-16'>
            <Typography.Text view='primary-small' color='secondary' tag='div'>
                {product.name}
            </Typography.Text>
            <Typography.Title tag='div' view='medium' font='system' weight='bold'>
                {rub(application.amount)}
            </Typography.Title>
            <KeyValue
                items={[
                    ['Срок', months(application.term_months)],
                    ['Ставка', `от ${percent(product.base_rate)} годовых`],
                    ['Цель', application.purpose_label],
                    ['Залог', product.collateral_required ? (application.collateral_type ?? 'нужен') : 'не нужен'],
                ]}
            />
        </div>
    );
}

// ---------------------------------------------------------------- шаг 3: проверка и отправка

function ReviewStep({ application, onBack }: { application: Application; onBack: () => void }) {
    const navigate = useNavigate();
    const submit = useSubmit();
    const [bki, setBki] = useState(false);
    const [pd, setPd] = useState(false);
    const [tried, setTried] = useState(false);
    const key = useRef(newIdempotencyKey());

    const send = async () => {
        setTried(true);
        if (!bki || !pd) return;
        const result = await submit.mutateAsync({ id: application.id, key: key.current });
        navigate(`/client/applications/${result.id}`);
    };

    return (
        <div className='grid-2'>
            <section className='card stack'>
                <Typography.Title tag='h2' view='small' font='system' weight='bold'>
                    Проверьте заявку
                </Typography.Title>
                <KeyValue
                    items={[
                        ['Компания', `${application.company.name}, ИНН ${application.company.inn}`],
                        ['Продукт', application.product.name],
                        ['Сумма', rub(application.amount)],
                        ['Срок', months(application.term_months)],
                        ['Цель', application.purpose_text || application.purpose_label],
                        [
                            'Выручка по вашим данным',
                            application.declared_revenue ? rub(application.declared_revenue) : 'не указана',
                        ],
                        ...(application.product.collateral_required
                            ? ([['Залог', `${application.collateral_type}, ${rub(application.collateral_value)}`]] as [
                                  string,
                                  string,
                              ][])
                            : []),
                        ['Документы', application.documents.length ? `${application.documents.length} шт.` : 'нет'],
                    ]}
                />
                <div className='stack-16'>
                    <Checkbox
                        checked={bki}
                        onChange={(_, { checked }) => setBki(checked)}
                        label='Согласие на запрос кредитной истории в бюро кредитных историй'
                        hint='По 218-ФЗ «О кредитных историях» без согласия банк не может получить отчёт'
                        error={tried && !bki ? 'Без согласия мы не сможем рассмотреть заявку' : undefined}
                        size={24}
                        block={true}
                    />
                    <Checkbox
                        checked={pd}
                        onChange={(_, { checked }) => setPd(checked)}
                        label='Согласие на обработку персональных данных'
                        hint='152-ФЗ «О персональных данных»: данные руководителя и представителя компании'
                        error={tried && !pd ? 'Без согласия мы не сможем рассмотреть заявку' : undefined}
                        size={24}
                        block={true}
                    />
                    <Typography.Text view='primary-small' color='secondary' tag='p'>
                        Прототип: согласия фиксируются отметкой в кабинете, без электронной подписи.
                    </Typography.Text>
                </div>
                <Plate view='common' rounded={true} limitContentWidth={false} title='Что будет дальше'>
                    Проверим данные в ЕГРЮЛ, ФНС, бюро кредитных историй и оценим риск — обычно это несколько минут.
                    Статус и все запросы банка будут здесь, в кабинете: без звонков, SMS и писем.
                </Plate>
            </section>
            <aside className='card sticky stack-16'>
                <Summary application={application} />
                <ErrorPlate error={submit.error} title='Заявка не отправлена' />
                <Button view='primary' size={56} block={true} onClick={send} loading={submit.isPending}>
                    Отправить заявку
                </Button>
                <Button view='secondary' size={56} block={true} onClick={onBack}>
                    Назад
                </Button>
                <Button view='transparent' size={48} block={true} onClick={() => navigate('/client')}>
                    Сохранить черновик и выйти
                </Button>
            </aside>
        </div>
    );
}
