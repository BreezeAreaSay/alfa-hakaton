"""Безопасность документов: тип файла по расширению и договор, который не ломают спецсимволы в данных."""

from decimal import Decimal
from types import SimpleNamespace

from app.services.documents import agreement_pdf, content_type_for, safe_name


def test_content_type_comes_from_extension_not_from_client():
    assert content_type_for("выписка.CSV") == "text/csv"
    assert content_type_for("x.pdf") == "application/pdf"
    assert content_type_for("scan.jpeg") == "image/jpeg"
    # неизвестное расширение — только скачивание, никогда не страница
    assert content_type_for("page.html") == "application/octet-stream"
    assert content_type_for("без_расширения") == "application/octet-stream"


def test_file_name_is_reduced_to_safe_characters():
    assert safe_name("../../etc/passwd") == "passwd"
    assert safe_name("отчёт <2026>.pdf") == "отчёт _2026_.pdf"


def test_agreement_survives_markup_characters_in_data():
    # Название из конструктора компании и цель от клиента попадают в разметку ReportLab: «<» и «&» её ломали
    company = SimpleNamespace(
        name="ООО «Рога & Копыта <тест>»",
        inn="0020000001",
        ogrn="1027700000001",
        address="г. Москва, ул. Тверская & Ко <корп. 2>",
        director_name="Иванов И. И.",
    )
    application = SimpleNamespace(
        number="2026-99999", company=company, purpose_text=("Закупка <партии> & сырья. " * 30)[:500]
    )
    offer = SimpleNamespace(
        product=SimpleNamespace(name="Кредит на развитие бизнеса"),
        amount=Decimal("2000000"),
        rate=Decimal("19.0"),
        term_months=12,
        monthly_payment=Decimal("184313"),
        overpayment=Decimal("211758"),
    )
    pdf, schedule = agreement_pdf(application, offer, "Иванов И. И. & <b>")
    assert pdf.startswith(b"%PDF") and len(schedule) == 12
