"""Конструктор тестовой компании: логин из названия и проверки параметров с понятными сообщениями."""

import pytest
from pydantic import ValidationError

from app.schemas import COMPANY_BUILDER_OKVED, CompanyBuilderIn
from app.services.companies import login_base, okved_options, unique_login


def messages(error: ValidationError) -> list[str]:
    return [item["msg"] for item in error.errors()]


def test_login_is_transliterated_from_name():
    assert login_base("ТехноМастер", "OOO") == "tehnomaster"
    assert login_base("Северный ветер", "OOO") == "severnyyveter"
    assert login_base("Альтаир", "OOO") == "altair"
    assert login_base("Щука & Ёж № 7", "OOO") == "schukaezh7"
    assert login_base("Смирнова Анна Викторовна", "IP") == "smirnova"
    assert login_base("???", "OOO") == "company"
    assert len(login_base("Очень длинное название компании без пробелов нигде", "OOO")) == 24


def test_unique_login_gets_a_number_on_collision():
    assert unique_login("start", set()) == "start"
    assert unique_login("start", {"start"}) == "start2"
    assert unique_login("start", {"start", "start2", "start3"}) == "start4"


def test_builder_defaults_describe_a_stable_company():
    body = CompanyBuilderIn(name="  Белые   ночи ")
    assert body.name == "Белые ночи"
    assert body.legal_form == "OOO" and body.company_status == "ACTIVE"
    assert body.registered_months_ago >= 12 and body.revenue > 0 and body.existing_monthly_payments == 0
    assert body.is_bank_client and body.account_months >= 12 and body.avg_monthly_inflow > 0


def test_builder_rejects_bad_parameters_in_russian():
    with pytest.raises(ValidationError) as error:
        CompanyBuilderIn(name="   ")
    assert messages(error.value) == ["Укажите название компании"]

    with pytest.raises(ValidationError) as error:
        CompanyBuilderIn(name="Тест", registered_months_ago=-1, revenue=0, okved="99.99", margin=2)
    assert messages(error.value) == [
        "Срок с регистрации — от 0 до 600 месяцев",
        "Неизвестный код ОКВЭД — выберите из справочника",
        "Выручка — от 1 ₽ до 1 трлн ₽",
        "Рентабельность — доля от −1 до 1: например, 0,08 — 8 %",
    ]

    with pytest.raises(ValidationError) as error:
        CompanyBuilderIn(name="Тест", current_overdue_days=40, max_overdue_days_24m=10)
    assert messages(error.value) == ["Максимальная просрочка за 24 месяца не может быть меньше текущей"]

    with pytest.raises(ValidationError) as error:
        CompanyBuilderIn(name="Тест", registered_months_ago=5, account_months=12)
    assert messages(error.value) == ["Счёт в банке не может быть открыт раньше регистрации компании"]

    with pytest.raises(ValidationError) as error:
        CompanyBuilderIn(name="Тест", avg_monthly_inflow=0)
    assert messages(error.value) == ["Для клиента банка укажите среднемесячные поступления на счёт"]


def test_non_client_has_no_account_data():
    body = CompanyBuilderIn(name="Тест", is_bank_client=False, account_months=12, avg_monthly_inflow=1)
    assert body.account_months == 0 and body.avg_monthly_inflow == 0


def test_okved_options_carry_industry_risk_and_typical_margin():
    options = {item.code: item for item in okved_options()}
    assert set(options) == set(COMPANY_BUILDER_OKVED)
    assert options["41.20"].industry_risk == "HIGH" and options["41.20"].typical_margin == 0.1
    assert options["62.01"].industry_risk == "LOW" and options["62.01"].typical_margin == 0.2
    assert options["46.39"].industry_risk == "MEDIUM" and options["46.39"].typical_margin == 0.08
