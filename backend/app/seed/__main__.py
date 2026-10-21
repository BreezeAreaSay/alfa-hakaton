"""Начальные данные. Повторный запуск ничего не дублирует.

python -m app.seed           # справочники, компании и демо-заявки, если заявок ещё нет
python -m app.seed --reset   # сбросить демо-данные: удалить заявки, снять сбои симулятора
"""

import logging
import sys

from sqlalchemy import func, select

from app.db import SessionLocal
from app.logging_setup import setup_logging
from app.models import Application
from app.seed.demo import preseed, reset_demo, seed_reference, sync_companies

log = logging.getLogger("seed")


def main() -> None:
    setup_logging()
    with SessionLocal() as db:
        seed_reference(db)
        sync_companies(db)
        if "--reset" in sys.argv[1:]:
            created = reset_demo(db)
            log.info("Демо-данные сброшены, созданы демо-заявки: %s", created)
        elif not db.scalar(select(func.count()).select_from(Application)):
            created = preseed(db)
            log.info("Созданы демо-заявки: %s", created)
        db.commit()
    log.info("Начальные данные готовы")


if __name__ == "__main__":
    main()
