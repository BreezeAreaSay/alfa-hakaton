"""Начальные данные. Повторный запуск ничего не дублирует."""

import logging

from sqlalchemy import func, select

from app.db import SessionLocal
from app.logging_setup import setup_logging
from app.models import Application
from app.seed.demo import preseed, seed_reference, sync_companies

log = logging.getLogger("seed")


def main() -> None:
    setup_logging()
    with SessionLocal() as db:
        seed_reference(db)
        sync_companies(db)
        if not db.scalar(select(func.count()).select_from(Application)):
            created = preseed(db)
            log.info("Созданы демо-заявки: %s", created)
        db.commit()
    log.info("Начальные данные готовы")


if __name__ == "__main__":
    main()
