"""Синтетический каталог продуктов (docs/credit-policy.md, «Каталог продуктов»)."""

from dataclasses import dataclass, field
from decimal import Decimal

from app.domain.enums import Purpose


@dataclass(frozen=True)
class ProductTerms:
    code: str
    name: str
    kind: str
    description: str
    min_amount: Decimal
    max_amount: Decimal
    min_term: int
    max_term: int
    base_rate: Decimal
    collateral_required: bool = False
    min_business_months: int = 0
    max_business_months: int | None = None
    requires_bank_account_months: int | None = None
    auto_limit: Decimal | None = None
    always_manual: bool = False
    purposes: tuple[str, ...] = field(default_factory=tuple)
    sort_order: int = 0

    @classmethod
    def from_model(cls, product) -> "ProductTerms":
        return cls(
            code=product.code,
            name=product.name,
            kind=product.kind,
            description=product.description,
            min_amount=Decimal(product.min_amount),
            max_amount=Decimal(product.max_amount),
            min_term=product.min_term,
            max_term=product.max_term,
            base_rate=Decimal(product.base_rate),
            collateral_required=product.collateral_required,
            min_business_months=product.min_business_months,
            max_business_months=product.max_business_months,
            requires_bank_account_months=product.requires_bank_account_months,
            auto_limit=Decimal(product.auto_limit) if product.auto_limit is not None else None,
            always_manual=product.always_manual,
            purposes=tuple(product.purposes or ()),
            sort_order=product.sort_order,
        )


ALL_PURPOSES = tuple(p.value for p in Purpose)

PRODUCTS: tuple[ProductTerms, ...] = (
    ProductTerms(
        code="GROWTH",
        name="Кредит на развитие бизнеса",
        kind="LOAN",
        description="Деньги на развитие без залога: закупки, новые точки, оборудование.",
        min_amount=Decimal("1000000"),
        max_amount=Decimal("30000000"),
        min_term=12,
        max_term=60,
        base_rate=Decimal("19.0"),
        min_business_months=12,
        auto_limit=Decimal("10000000"),
        purposes=(Purpose.WORKING_CAPITAL, Purpose.EXPANSION, Purpose.EQUIPMENT),
        sort_order=1,
    ),
    ProductTerms(
        code="EXPRESS",
        name="Экспресс-кредит без залога",
        kind="LOAN",
        description="Быстрое решение без залога и лишних документов — на текущие нужды бизнеса.",
        min_amount=Decimal("300000"),
        max_amount=Decimal("5000000"),
        min_term=6,
        max_term=36,
        base_rate=Decimal("21.0"),
        min_business_months=9,
        auto_limit=Decimal("5000000"),
        purposes=(Purpose.WORKING_CAPITAL, Purpose.CASH_GAP),
        sort_order=2,
    ),
    ProductTerms(
        code="SECURED",
        name="Кредит под залог",
        kind="LOAN",
        description="Крупные суммы по ставке ниже — под залог недвижимости, транспорта или оборудования.",
        min_amount=Decimal("3000000"),
        max_amount=Decimal("150000000"),
        min_term=12,
        max_term=120,
        base_rate=Decimal("15.5"),
        collateral_required=True,
        min_business_months=12,
        always_manual=True,
        purposes=(Purpose.EQUIPMENT, Purpose.EXPANSION),
        sort_order=3,
    ),
    ProductTerms(
        code="OVERDRAFT",
        name="Овердрафт",
        kind="OVERDRAFT",
        description=(
            "Запасной кошелёк на расчётном счёте: платите поставщикам, даже когда своих денег не хватает. "
            "Проценты — только за дни, когда пользовались деньгами."
        ),
        min_amount=Decimal("100000"),
        max_amount=Decimal("20000000"),
        min_term=12,
        max_term=12,
        base_rate=Decimal("13.0"),
        min_business_months=6,
        requires_bank_account_months=6,
        auto_limit=Decimal("5000000"),
        purposes=(Purpose.CASH_GAP,),
        sort_order=4,
    ),
    ProductTerms(
        code="CREDIT_LINE",
        name="Возобновляемая кредитная линия",
        kind="CREDIT_LINE",
        description=(
            "Оформите один раз и берите деньги частями в пределах лимита. Проценты — только на использованную часть."
        ),
        min_amount=Decimal("1000000"),
        max_amount=Decimal("50000000"),
        min_term=12,
        max_term=24,
        base_rate=Decimal("14.5"),
        min_business_months=12,
        auto_limit=Decimal("10000000"),
        purposes=(Purpose.WORKING_CAPITAL, Purpose.CASH_GAP),
        sort_order=5,
    ),
    ProductTerms(
        code="STARTUP",
        name="Кредит для начинающего бизнеса",
        kind="LOAN",
        description="Для бизнеса младше года: небольшая сумма на старт и развитие.",
        min_amount=Decimal("100000"),
        max_amount=Decimal("3000000"),
        min_term=6,
        max_term=36,
        base_rate=Decimal("23.0"),
        min_business_months=3,
        max_business_months=12,
        auto_limit=Decimal("1000000"),
        purposes=ALL_PURPOSES,
        sort_order=6,
    ),
)

PURPOSE_PRODUCTS: dict[str, tuple[str, ...]] = {
    Purpose.WORKING_CAPITAL: ("GROWTH", "EXPRESS", "CREDIT_LINE"),
    Purpose.CASH_GAP: ("OVERDRAFT", "CREDIT_LINE", "EXPRESS"),
    Purpose.EQUIPMENT: ("SECURED", "GROWTH"),
    Purpose.EXPANSION: ("GROWTH", "SECURED"),
}

YOUNG_BUSINESS_MONTHS = 12


def products_for_purpose(purpose: str, business_months: int | None) -> tuple[str, ...]:
    codes = PURPOSE_PRODUCTS.get(purpose, ())
    if business_months is not None and business_months < YOUNG_BUSINESS_MONTHS:
        return ("STARTUP", *codes)
    return codes
