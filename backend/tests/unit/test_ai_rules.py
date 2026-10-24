import pytest

from app.services.ai import parse_need_rules

CASES = [
    ("Нужно закупить партию товара к сезону на 3 млн, верну за полгода", "WORKING_CAPITAL", 3_000_000, 6),
    ("Хотим купить два грузовика за 12 млн на 5 лет", "EQUIPMENT", 12_000_000, 60),
    ("Покупатели платят с отсрочкой, нужно 800 тыс чтобы оплатить поставщикам на год", "CASH_GAP", 800_000, 12),
    ("Открываем вторую точку кофейни, нужно 2,5 млн на 3 года", "EXPANSION", 2_500_000, 36),
    ("Нужен кредит 1 500 000 рублей на 18 месяцев на закупку сырья", "WORKING_CAPITAL", 1_500_000, 18),
    ("Не хватает денег на зарплату и налоги, нужно 400к на 6 мес", "CASH_GAP", 400_000, 6),
    ("Хочу новый станок за полтора миллиона", "EQUIPMENT", 1_500_000, None),
    ("6 млн на развитие бизнеса, верну за 24 месяца", "EXPANSION", 6_000_000, 24),
    # «развитие» в названии продукта не перевешивает явную задачу
    ("Кредит на развитие бизнеса: закупка товара на 2 млн на год", "WORKING_CAPITAL", 2_000_000, 12),
]


@pytest.mark.parametrize(("text", "purpose", "amount", "term"), CASES)
def test_rules_extract_parameters(text, purpose, amount, term):
    result = parse_need_rules(text)
    assert result["purpose"] == purpose
    assert result["amount"] == amount
    assert result["term_months"] == term


def test_rules_do_not_invent_missing_values():
    result = parse_need_rules("Нужен кредит для бизнеса")
    assert result["amount"] is None
    assert result["term_months"] is None
