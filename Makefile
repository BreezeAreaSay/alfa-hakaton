# Частые команды. Нужны Docker с Compose v2; для тестов — uv (Python) и Node.js 22.

COMPOSE ?= docker compose
APP_URL ?= http://localhost:$(or $(APP_PORT),8080)

.DEFAULT_GOAL := help
.PHONY: help up down clean logs ps reset test test-api e2e ai-eval openapi

help: ## Список команд
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-9s %s\n", $$1, $$2}'

up: ## Собрать и запустить стенд
	$(COMPOSE) up -d --build --wait
	@echo "Готово: $(APP_URL)"

down: ## Остановить стенд, данные сохраняются
	$(COMPOSE) down

clean: ## Остановить стенд и удалить данные
	$(COMPOSE) down -v

logs: ## Логи всех сервисов
	$(COMPOSE) logs -f --tail=100

ps: ## Состояние сервисов
	$(COMPOSE) ps

reset: ## Сбросить демо-данные: удалить заявки, снять сбои симулятора
	$(COMPOSE) exec api python -m app.seed --reset

test: ## Линтеры и юнит-тесты бэкенда и симулятора
	cd backend && uv run ruff check . && uv run pytest tests/unit -q
	cd simulator && uv run ruff check . && uv run pytest -q

test-api: ## Сценарии через API на запущенном стенде
	cd backend && RUN_INTEGRATION=1 API_URL=$(APP_URL) uv run pytest tests/integration -q

e2e: ## Сценарии в браузере (Playwright) на запущенном стенде
	cd e2e && npm ci --no-audit --no-fund && npx playwright install chromium && E2E_BASE_URL=$(APP_URL) npx playwright test

ai-eval: ## Качество разбора потребности: правила, а при AI_ENABLED=true и модель
	$(COMPOSE) exec api sh -c 'if [ "$$AI_ENABLED" = "true" ]; then python -m app.ai_eval --llm; else python -m app.ai_eval; fi'

openapi: ## Обновить docs/api/openapi.json из кода
	cd backend && uv run python -m app.export_openapi ../docs/api/openapi.json
