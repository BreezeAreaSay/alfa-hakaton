"""Объяснимая ставка: разбор, подсказки «как получить ниже», «вам может подойти» и советы после отказа."""

from decimal import Decimal

from app.domain.catalog import KEY_RATE, PRODUCTS
from app.domain.policy import ADVICE, decline_alternatives, next_steps, rate_breakdown, rate_hints
from app.domain.scoring import margin_for_class, score
from tests.unit.factories import strong_company

P = {p.code: p for p in PRODUCTS}


def hints_for(product_code: str, purpose: str, **overrides):
    f = strong_company(**overrides)
    s = score(f)
    margin = margin_for_class(s.risk_class)
    assert margin is not None
    rate = P[product_code].base_rate + margin
    factors = [x.to_dict() for x in s.factors]
    return rate_hints(P[product_code], f, risk_margin=margin, factors=factors, purpose=purpose, rate=rate), margin


def test_rate_breakdown_sums_to_offer_rate():
    s = score(strong_company())
    margin = margin_for_class(s.risk_class)
    assert margin == Decimal("0")
    b = rate_breakdown(P["GROWTH"], margin, offer_rate=Decimal("19.0"))
    assert b["key_rate"] == KEY_RATE
    assert b["product_spread"] == Decimal("5.0")
    assert b["key_rate"] + b["product_spread"] + b["risk_margin"] + b["adjustment"] == b["rate"] == Decimal("19.0")


def test_analyst_discount_is_shown_as_adjustment():
    b = rate_breakdown(P["SECURED"], Decimal("1.5"), offer_rate=Decimal("16.0"))
    assert b["adjustment"] == Decimal("-1.0")
    assert b["rate"] == Decimal("16.0")


def test_cheaper_products_for_the_same_purpose_only():
    hints, _ = hints_for("GROWTH", "WORKING_CAPITAL")
    products = [h for h in hints if h["kind"] == "product"]
    assert [h["product_code"] for h in products] == ["CREDIT_LINE"]
    assert products[0]["rate"] == Decimal("18.0")
    # У линии проценты считаются от использованного лимита, поэтому переплаты не сравниваем
    assert products[0]["saving"] is None
    assert not [h for h in hints if h["kind"] == "risk"]  # класс A — надбавки нет


def test_secured_credit_is_offered_for_expansion():
    hints, _ = hints_for("GROWTH", "EXPANSION", amount=Decimal("5000000"))
    assert [h["product_code"] for h in hints] == ["SECURED"]
    assert "залог" in hints[0]["text"]
    assert hints[0]["saving"] is not None and hints[0]["saving"] > 0  # оба продукта с графиком: переплата сравнима


def test_risk_margin_hint_names_what_lowers_it():
    hints, margin = hints_for("GROWTH", "EQUIPMENT", max_overdue_days_24m=20, revenue_growth=-0.2)
    assert margin > 0
    risk = [h for h in hints if h["kind"] == "risk"]
    assert len(risk) == 1
    assert "просрочек" in risk[0]["text"] and "выручка" in risk[0]["text"]


def test_decline_alternatives_fit_the_limit():
    # Прибыль небольшая: кредит на развитие от 1 млн не проходит по лимиту, экспресс-кредит доступен
    f = strong_company(
        amount=Decimal("1000000"),
        term_months=12,
        operating_profit_month=Decimal("90000"),
        existing_payments=Decimal("20000"),
    )
    s = score(f)
    margin = margin_for_class(s.risk_class)
    assert margin is not None
    items = decline_alternatives(P["GROWTH"], f, risk_margin=margin, purpose="WORKING_CAPITAL", term_months=12)
    assert items and items[0]["product_code"] in {"EXPRESS", "CREDIT_LINE"}
    for item in items:
        assert P[item["product_code"]].min_amount <= item["max_amount"] <= P[item["product_code"]].max_amount


def factors_of(**overrides) -> list[dict]:
    return [x.to_dict() for x in score(strong_company(**overrides)).factors]


def test_next_steps_do_not_repeat():
    assert next_steps(["S03"], []) == [ADVICE["S03"]]
    assert next_steps(["S05"], ["R01"]) == [ADVICE["S05"]]
    assert next_steps([], ["R07"]) == []
    young = factors_of(business_months=5)
    assert next_steps(["S05"], ["R01"], young) == next_steps([], ["R01"], young)
    assert len(next_steps(["S05"], ["R01"], young)) == 1


def test_stop_factor_advice_is_not_mixed_with_risk_advice():
    # Ликвидация или просрочка вместе с классом E: совет только по стоп-фактору. Совет по оценке повторял бы
    # совет по S03 или говорил бы о просрочках и налогах, которых у компании нет
    weak = factors_of(revenue_growth=-0.4, tax_debt=Decimal("500000"), max_overdue_days_24m=45)
    assert next_steps(["S01", "S05"], [], weak) == [ADVICE["S01"]]
    assert next_steps(["S03", "S05"], [], weak) == [ADVICE["S03"]]
    assert next_steps(["S02", "S05"], []) == [ADVICE["S02"]]
    assert next_steps(["S04", "S05"], [], factors_of(business_months=2)) == [ADVICE["S04"]]


def test_risk_advice_names_the_application_factors():
    # Молодой бизнес, отказ аналитика по R01: просрочек и налогового долга у компании нет — совет про срок работы
    assert next_steps([], ["R01"], factors_of(business_months=5)) == [
        "Оценка станет выше, когда бизнес проработает дольше. Начать можно с небольшой суммы через несколько месяцев"
    ]
    # До двух факторов с наибольшим отрицательным вкладом; отраслевой риск (−40) пропускается — отрасль не меняют
    factors = factors_of(industry_risk="HIGH", tax_debt=Decimal("50000"), margin=0.03)
    assert [x["code"] for x in sorted(factors, key=lambda x: x["points"]) if x["points"] < 0] == [
        "INDUSTRY",
        "TAX_DEBT",
        "MARGIN",
    ]
    assert next_steps(["S05"], [], factors) == [
        "Оценка станет выше, когда будет погашена налоговая задолженность и вырастет прибыльность бизнеса. "
        "Начать можно с небольшой суммы через несколько месяцев"
    ]
    # Отрицательных факторов, на которые клиент может повлиять, нет — общий совет
    assert next_steps([], ["R01"], factors_of()) == [ADVICE["R01"]]
    assert next_steps([], ["R01"], factors_of(industry_risk="HIGH")) == [ADVICE["R01"]]
    assert next_steps(["S05"], []) == [ADVICE["S05"]]
