"""personal events

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-24 22:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("events", sa.Column("user_id", sa.Uuid(), nullable=True))
    op.create_foreign_key("events_user_id_fkey", "events", "users", ["user_id"], ["id"])
    op.create_index(op.f("ix_events_user_id"), "events", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_events_user_id"), table_name="events")
    op.drop_constraint("events_user_id_fkey", "events", type_="foreignkey")
    op.drop_column("events", "user_id")
