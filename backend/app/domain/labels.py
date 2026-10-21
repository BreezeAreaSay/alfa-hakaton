"""Тексты для пользователей: статусы, шаги конвейера, цели, документы."""

from app.domain.enums import AppStatus, DocumentKind, Purpose, StepCode

STATUS_LABELS: dict[str, dict[str, str]] = {
    AppStatus.DRAFT: {"client": "Черновик", "bank": "Черновик", "next": "Заполните и отправьте заявку"},
    AppStatus.SUBMITTED: {"client": "Заявка отправлена", "bank": "Новая", "next": "Начинаем проверку"},
    AppStatus.IN_PROCESSING: {
        "client": "Проверяем заявку",
        "bank": "Автоматическая обработка",
        "next": "Обычно это занимает несколько минут",
    },
    AppStatus.NEED_INFO: {"client": "Нужна информация", "bank": "Ожидает клиента", "next": "Ответьте на запрос банка"},
    AppStatus.MANUAL_REVIEW: {
        "client": "Заявку рассматривает специалист",
        "bank": "Ручное рассмотрение",
        "next": "Специалист изучает заявку",
    },
    AppStatus.OFFER: {
        "client": "Предложение готово",
        "bank": "Предложение выдано",
        "next": "Примите условия или откажитесь",
    },
    AppStatus.ACCEPTED: {
        "client": "Готовим документы",
        "bank": "Условия приняты",
        "next": "Документы появятся в кабинете",
    },
    AppStatus.SIGNING: {
        "client": "Подпишите документы",
        "bank": "Ожидает подписи",
        "next": "Подпишите договор в кабинете",
    },
    AppStatus.SIGNED: {"client": "Документы подписаны", "bank": "Подписано", "next": "Перечисляем деньги"},
    AppStatus.ISSUED: {"client": "Кредит выдан", "bank": "Выдан", "next": "Смотрите график платежей"},
    AppStatus.REJECTED: {"client": "Банк отказал", "bank": "Отказ", "next": "Причина и что можно сделать"},
    AppStatus.DECLINED: {
        "client": "Вы отказались от предложения",
        "bank": "Отказ клиента",
        "next": "Можно подать новую заявку",
    },
    AppStatus.CANCELLED: {"client": "Заявка отозвана", "bank": "Отозвана", "next": "Можно подать новую заявку"},
    AppStatus.EXPIRED: {"client": "Срок истёк", "bank": "Истёк срок", "next": "Можно подать новую заявку"},
}

STEP_LABELS: dict[str, dict[str, str]] = {
    StepCode.DATA_CHECK: {"title": "Проверка данных заявки", "waiting": "Проверяем заявку"},
    StepCode.EGRUL: {"title": "Сведения из ЕГРЮЛ / ЕГРИП", "waiting": "Ждём ответа реестра ЕГРЮЛ / ЕГРИП"},
    StepCode.FNS: {"title": "Проверка в ФНС", "waiting": "Ждём ответа ФНС"},
    StepCode.GIRBO: {"title": "Бухгалтерская отчётность", "waiting": "Ждём ответа ГИР БО"},
    StepCode.BKI: {"title": "Кредитная история", "waiting": "Ждём ответа бюро кредитных историй"},
    StepCode.BANK: {"title": "Обороты по счёту в банке", "waiting": "Ждём ответа банковской системы"},
    StepCode.SCORING: {"title": "Оценка риска", "waiting": "Оцениваем риск"},
    StepCode.POLICY: {"title": "Кредитное решение", "waiting": "Принимаем решение"},
}

PURPOSE_LABELS: dict[str, str] = {
    Purpose.WORKING_CAPITAL: "Пополнить оборотные средства, закупить товар",
    Purpose.CASH_GAP: "Закрыть кассовый разрыв, рассчитаться с поставщиками",
    Purpose.EQUIPMENT: "Купить оборудование или транспорт",
    Purpose.EXPANSION: "Расширить бизнес, открыть новую точку",
}

DOCUMENT_LABELS: dict[str, str] = {
    DocumentKind.BANK_STATEMENT: "Выписка по расчётному счёту",
    DocumentKind.FIN_STATEMENT: "Бухгалтерская отчётность",
    DocumentKind.COLLATERAL: "Документы по залогу",
    DocumentKind.OTHER: "Другой документ",
    DocumentKind.AGREEMENT: "Кредитный договор",
    DocumentKind.SCHEDULE: "График платежей",
}

COMPANY_STATUS_LABELS: dict[str, str] = {
    "ACTIVE": "Действующая",
    "LIQUIDATING": "В процессе ликвидации",
    "REORGANIZING": "В процессе реорганизации",
    "BANKRUPTCY": "Процедура банкротства",
    "LIQUIDATED": "Ликвидирована",
}

INFO_ITEM_PRESETS: list[dict[str, str]] = [
    {
        "code": "BANK_STATEMENT",
        "title": "Выписка по расчётному счёту за последние 12 месяцев",
        "hint": "Файл выгрузки из банка в формате 1С (.txt) или таблица CSV.",
    },
    {"code": "FIN_STATEMENT", "title": "Бухгалтерская отчётность за последний год", "hint": "PDF или скан."},
    {
        "code": "TAX_EXPLANATION",
        "title": "Пояснение по налоговой задолженности",
        "hint": "Когда и как планируете погасить. Можно приложить платёжное поручение.",
    },
    {
        "code": "ADDRESS_CONFIRMATION",
        "title": "Документ о праве пользования офисом",
        "hint": "Договор аренды или свидетельство о собственности.",
    },
    {"code": "COLLATERAL_DOCS", "title": "Документы по залогу", "hint": "Документы о праве собственности, оценка."},
    {"code": "CONTRACTS", "title": "Действующие договоры с покупателями", "hint": "Подтверждают будущую выручку."},
    {"code": "OTHER", "title": "Другое", "hint": "Опишите, что нужно, в комментарии."},
]
