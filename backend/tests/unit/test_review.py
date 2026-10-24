from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.domain.enums import Priority
from app.domain.policy import review_flags
from app.domain.review import PRIORITY_RANK, pick_analyst, review_priority
from app.domain.scoring import score
from tests.unit.factories import strong_company

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)


def priority(
    *, status: str = "MANUAL_REVIEW", left: timedelta | None = timedelta(hours=20), amount: str = "3000000", flags=()
):
    sla_due_at = NOW + left if left is not None else None
    return review_priority(status, now=NOW, sla_due_at=sla_due_at, amount=Decimal(amount), flags=flags)


def test_only_manual_review_has_priority():
    for status in ("SUBMITTED", "IN_PROCESSING", "NEED_INFO", "OFFER", "REJECTED"):
        assert priority(status=status, left=-timedelta(hours=1), amount="60000000", flags=["F01"]) == (None, [])


def test_ordinary_application_has_normal_priority_without_reasons():
    assert priority() == (Priority.NORMAL, [])


def test_overdue_review_is_high():
    assert priority(left=-timedelta(minutes=1)) == (Priority.HIGH, ["Срок рассмотрения истёк"])


def test_less_than_four_hours_left_is_high():
    assert priority(left=timedelta(hours=3, minutes=59)) == (Priority.HIGH, ["До конца срока меньше 4 часов"])
    # Ровно 4 часа — ещё не срочно
    assert priority(left=timedelta(hours=4)) == (Priority.NORMAL, [])


def test_large_amount_is_medium():
    assert priority(amount="10000000") == (Priority.MEDIUM, ["Сумма от 10\u00a0млн\u00a0₽"])
    assert priority(amount="9999999.99") == (Priority.NORMAL, [])


def test_flags_that_need_a_check_raise_priority():
    assert priority(flags=["F06"]) == (Priority.MEDIUM, ["Флаг F06 требует проверки"])
    assert priority(flags=["F01", "F03", "F04"]) == (Priority.MEDIUM, ["Флаги F01, F03, F04 требуют проверки"])


def test_risk_class_flag_alone_does_not_raise_priority():
    # F07 (класс C или D) — оценка риска, по ней аналитик решает в обычном порядке
    assert priority(flags=["F07"]) == (Priority.NORMAL, [])
    assert priority(flags=["F02", "F07"]) == (Priority.MEDIUM, ["Флаг F02 требует проверки"])


def test_waiting_for_source_is_normal_whatever_else():
    # Источник не ответил: пока он не восстановится, аналитику нечего делать — ни срок, ни сумма не важны
    expected = (Priority.NORMAL, ["Ждём ответа источника"])
    assert priority(flags=["F05"]) == expected
    assert priority(left=-timedelta(hours=2), amount="60000000", flags=["F01", "F05"]) == expected


def test_high_priority_lists_every_reason_deadline_first():
    assert priority(left=timedelta(hours=1), amount="12000000", flags=["F01", "F02"]) == (
        Priority.HIGH,
        ["До конца срока меньше 4 часов", "Сумма от 10\u00a0млн\u00a0₽", "Флаги F01, F02 требуют проверки"],
    )


def test_policy_flags_of_company_with_mass_address_and_tax_debt():
    # Как у «Вектор Логистик»: массовый адрес и налоговая задолженность, 12 млн ₽
    features = strong_company(mass_address=True, tax_debt=Decimal("80000"), amount=Decimal("12000000"))
    flags = review_flags(features, score(features))
    assert flags == ["F01", "F02"]
    assert priority(amount="12000000", flags=flags) == (
        Priority.MEDIUM,
        ["Сумма от 10\u00a0млн\u00a0₽", "Флаги F01, F02 требуют проверки"],
    )


def test_missing_deadline_is_not_urgent():
    assert priority(left=None) == (Priority.NORMAL, [])


def test_queue_order_high_medium_normal():
    levels = [Priority.NORMAL, Priority.HIGH, Priority.MEDIUM]
    assert sorted(levels, key=PRIORITY_RANK.__getitem__) == [Priority.HIGH, Priority.MEDIUM, Priority.NORMAL]


def test_least_loaded_analyst_gets_the_application():
    assert pick_analyst({"analyst": 2, "analyst2": 1}) == "analyst2"
    assert pick_analyst({"analyst": 0, "analyst2": 3}) == "analyst"


def test_equal_load_goes_to_first_login_alphabetically():
    assert pick_analyst({"analyst2": 1, "analyst": 1}) == "analyst"
    assert pick_analyst({"petrov": 0, "ivanova": 0, "sidorov": 0}) == "ivanova"


def test_nobody_to_assign_without_analysts():
    assert pick_analyst({}) is None


def test_applications_arriving_one_by_one_alternate_between_analysts():
    loads = {"analyst": 0, "analyst2": 0}
    chosen = []
    for _ in range(4):
        login = pick_analyst(loads)
        chosen.append(login)
        loads[login] += 1
    assert chosen == ["analyst", "analyst2", "analyst", "analyst2"]
