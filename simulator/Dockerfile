FROM python:3.12.7-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_PROJECT_ENVIRONMENT=/opt/venv PATH="/opt/venv/bin:$PATH"
WORKDIR /srv

RUN pip install --no-cache-dir uv==0.11.32
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY sim ./sim

RUN useradd --create-home --uid 10001 app
USER app

EXPOSE 8100
CMD ["uvicorn", "sim.main:app", "--host", "0.0.0.0", "--port", "8100"]
