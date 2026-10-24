"""Хранение файлов и формирование кредитного договора с графиком платежей (PDF)."""

import contextlib
import hashlib
import io
import re
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.enums import DocumentKind, DocumentSource
from app.domain.finance import payment_schedule
from app.domain.text import months_text, rub
from app.models import Application, Document, Offer, User

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".txt", ".csv"}

# Тип файла определяется по расширению, а не по заголовку, который прислал клиент: иначе «x.pdf» с типом text/html
# открылся бы в браузере аналитика как страница нашего сайта и мог бы прочитать его токен (хранимый XSS)
CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".txt": "text/plain",
    ".csv": "text/csv",
}


def content_type_for(file_name: str) -> str:
    """Тип для хранения и выдачи файла; неизвестное расширение отдаётся как двоичные данные и только скачивается."""
    return CONTENT_TYPES.get(Path(file_name).suffix.lower(), "application/octet-stream")


# Шрифты с кириллицей лежат в репозитории, чтобы сборка образа не зависела от пакетного менеджера ОС
FONT_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"


class UploadError(ValueError):
    pass


def _storage_root() -> Path:
    root = Path(get_settings().files_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def safe_name(file_name: str) -> str:
    name = Path(file_name).name
    name = re.sub(r"[^\w.\- ]", "_", name, flags=re.UNICODE).strip() or "file"
    return name[:120]


def store(
    db: Session,
    application: Application,
    *,
    file_name: str,
    data: bytes,
    kind: DocumentKind,
    source: DocumentSource,
    user: User | None,
    info_request_id: uuid.UUID | None = None,
) -> Document:
    settings = get_settings()
    if len(data) == 0:
        raise UploadError("Файл пустой")
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise UploadError(f"Файл больше {settings.max_upload_mb} МБ")
    if source == DocumentSource.CLIENT and Path(file_name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise UploadError("Можно загрузить PDF, JPG, PNG, TXT или CSV")
    name = safe_name(file_name)
    key = f"{application.id}/{uuid.uuid4().hex}_{name}"
    path = _storage_root() / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    document = Document(
        application_id=application.id,
        kind=kind,
        source=source,
        file_name=name,
        content_type=content_type_for(name),
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        storage_key=key,
        uploaded_by=user.id if user else None,
        info_request_id=info_request_id,
    )
    db.add(document)
    return document


def read(document: Document) -> bytes:
    return (_storage_root() / document.storage_key).read_bytes()


def discard(storage_keys: Iterable[str]) -> None:
    """Удаляет файлы с диска. Вызывать после фиксации транзакции, которая удалила записи о документах."""
    root = _storage_root()
    for key in storage_keys:
        path = root / key
        path.unlink(missing_ok=True)
        with contextlib.suppress(OSError):
            path.parent.rmdir()  # каталог заявки, если в нём больше нет файлов


_fonts_ready = False


def _fonts() -> tuple[str, str]:
    global _fonts_ready
    if not _fonts_ready:
        pdfmetrics.registerFont(TTFont("DejaVu", str(FONT_DIR / "DejaVuSans.ttf")))
        pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(FONT_DIR / "DejaVuSans-Bold.ttf")))
        _fonts_ready = True
    return "DejaVu", "DejaVu-Bold"


def _styles() -> dict[str, ParagraphStyle]:
    regular, bold = _fonts()
    return {
        "title": ParagraphStyle("title", fontName=bold, fontSize=15, leading=19, spaceAfter=4),
        "subtitle": ParagraphStyle(
            "subtitle", fontName=regular, fontSize=9, leading=12, textColor=colors.HexColor("#6F7079")
        ),
        "h": ParagraphStyle("h", fontName=bold, fontSize=11, leading=15, spaceBefore=8, spaceAfter=4),
        "p": ParagraphStyle("p", fontName=regular, fontSize=9.5, leading=13.5),
        "note": ParagraphStyle("note", fontName=regular, fontSize=8, leading=11, textColor=colors.HexColor("#6F7079")),
        "cell": ParagraphStyle("cell", fontName=regular, fontSize=8.5, leading=11),
    }


def _table(rows: list[list[Any]], widths: list[float], header: bool = True) -> Table:
    regular, bold = _fonts()
    table = Table(rows, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("FONT", (0, 0), (-1, -1), regular, 8.5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#DBDDE2")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    if header:
        style += [("FONT", (0, 0), (-1, 0), bold, 8.5), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F2F3F5"))]
    table.setStyle(TableStyle(style))
    return table


def agreement_pdf(application: Application, offer: Offer, signer: str | None) -> tuple[bytes, list]:
    """Демонстрационный договор с графиком платежей. Возвращает PDF и строки графика."""
    s = _styles()
    today = datetime.now(UTC).date()
    company = application.company
    schedule = payment_schedule(offer.amount, offer.rate, offer.term_months, today)
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=f"Кредитный договор № {application.number}",
    )
    # Название, адрес и подписант приходят из реестров и конструктора компании, цель — от клиента: в разметке
    # ReportLab символы «<» и «&» ломают разбор абзаца, поэтому значения экранируются
    name, address = escape(company.name), escape(company.address or "")
    signer_name = escape(signer or company.director_name or "—")
    story = [
        Paragraph(f"Кредитный договор № {application.number}", s["title"]),
        Paragraph(
            f"Дата формирования: {today:%d.%m.%Y}. Демонстрационный документ, не является офертой.", s["subtitle"]
        ),
        Spacer(1, 6 * mm),
        Paragraph("1. Стороны", s["h"]),
        Paragraph("Кредитор: Банк (демонстрационный стенд кредитного конвейера).", s["p"]),
        Paragraph(
            f"Заёмщик: {name}, ИНН {company.inn}"
            + (f", ОГРН {company.ogrn}" if company.ogrn else "")
            + (f", адрес: {address}" if address else "")
            + ".",
            s["p"],
        ),
        Paragraph(f"Подписант со стороны заёмщика: {signer_name}.", s["p"]),
        Paragraph("2. Условия кредита", s["h"]),
        _table(
            [
                ["Продукт", offer.product.name],
                ["Сумма", rub(offer.amount)],
                ["Срок", months_text(offer.term_months)],
                ["Процентная ставка", f"{offer.rate}% годовых".replace(".", ",")],
                ["Ежемесячный платёж", rub(offer.monthly_payment)],
                ["Переплата за весь срок", rub(offer.overpayment)],
                # длинная цель переносится по строкам внутри ячейки, а не уходит за край страницы
                ["Цель", Paragraph(escape(application.purpose_text or "—"), s["cell"])],
            ],
            [55 * mm, 119 * mm],
            header=False,
        ),
        Paragraph("3. Порядок погашения", s["h"]),
        Paragraph("Погашение ежемесячными платежами по графику ниже. Досрочное погашение — без комиссии.", s["p"]),
        Spacer(1, 3 * mm),
        _table(
            [["№", "Дата", "Платёж", "Основной долг", "Проценты", "Остаток"]]
            + [
                [str(r.n), f"{r.due_date:%d.%m.%Y}", rub(r.payment), rub(r.principal), rub(r.interest), rub(r.balance)]
                for r in schedule
            ],
            [10 * mm, 25 * mm, 34 * mm, 36 * mm, 32 * mm, 37 * mm],
        ),
        Spacer(1, 6 * mm),
        Paragraph(
            "Документ подписывается простой электронной подписью в личном кабинете: подписание подтверждается "
            "вводом пароля, в журнале фиксируются хэш документа, время и пользователь.",
            s["note"],
        ),
    ]
    doc.build(story)
    return buffer.getvalue(), schedule
