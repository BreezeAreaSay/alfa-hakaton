#!/usr/bin/env bash
# Установка стенда на сервер одной командой: Ubuntu 22.04/24.04 или Debian 12, хватит одного ядра и 2 ГБ памяти.
# Подробности и ручной путь — docs/deploy.md.
#
#   sudo bash deploy/install.sh                                  # HTTP на порту 80, готовые образы из GitHub
#   sudo bash deploy/install.sh --domain 203-0-113-10.sslip.io   # HTTPS через Caddy (нужны открытые порты 80 и 443)
#   sudo bash deploy/install.sh --build                          # собрать образы на сервере, а не скачивать
#   sudo bash deploy/install.sh --tag v1.0.0                     # образы сдаваемой версии (по умолчанию latest)
#   sudo bash deploy/install.sh --port 8080                      # другой порт для HTTP без домена
#
# Повторный запуск обновляет стенд: скачивает (или собирает) новые образы и перезапускает сервисы.
# База данных, загруженные файлы и созданные в конструкторе компании сохраняются.
set -euo pipefail

DOMAIN=""
PORT=80
BUILD=0
DRY_RUN=0
TAG="${IMAGES_TAG:-latest}"
OWNER="${IMAGES_OWNER:-stonebridgeway}"

usage() {
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="${2:?после --domain укажите домен}"; shift 2 ;;
        --port) PORT="${2:?после --port укажите номер порта}"; shift 2 ;;
        --tag) TAG="${2:?после --tag укажите тег образов}"; shift 2 ;;
        --owner) OWNER="${2:?после --owner укажите владельца репозитория}"; shift 2 ;;
        --build) BUILD=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h | --help) usage ;;
        *) echo "Неизвестный параметр: $1" >&2; usage 1 ;;
    esac
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { # показать команду и выполнить (при --dry-run — только показать)
    printf '  $ %s\n' "$*"
    [ "$DRY_RUN" -eq 1 ] || "$@"
}
secret() {
    if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    echo "Нужны права администратора: sudo bash deploy/install.sh ..." >&2
    exit 1
fi

say "Память и файл подкачки"
MEM_MB=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 3000 ] && [ "$SWAP_MB" -eq 0 ]; then
    echo "Памяти ${MEM_MB} МБ и нет подкачки — создаём /swapfile на 2 ГБ (нужен сборке образов и спокойной работе)"
    run fallocate -l 2G /swapfile
    run chmod 600 /swapfile
    run mkswap /swapfile
    run swapon /swapfile
    if [ "$DRY_RUN" -eq 0 ] && ! grep -q '^/swapfile' /etc/fstab; then echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
else
    echo "Памяти ${MEM_MB} МБ, подкачки ${SWAP_MB} МБ — достаточно"
fi

say "Docker с Compose v2"
if docker compose version >/dev/null 2>&1; then
    docker compose version
else
    echo "Docker не найден — устанавливаем официальным скриптом get.docker.com"
    run sh -c 'curl -fsSL https://get.docker.com | sh'
    run systemctl enable --now docker
fi

say "Настройки в .env"
if [ ! -f .env ]; then
    cp .env.example .env
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(secret 32)|" .env
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret 16)|" .env
    sed -i "s|^WORKER_CONCURRENCY=.*|WORKER_CONCURRENCY=2|" .env
    echo "Создан .env со случайными JWT_SECRET и POSTGRES_PASSWORD, WORKER_CONCURRENCY=2"
else
    echo ".env уже есть — секреты и настройки сохранены"
fi
set_env() { # ключ значение: заменить строку в .env или добавить её
    if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
if [ -n "$DOMAIN" ]; then
    set_env DOMAIN "$DOMAIN"
    set_env APP_PORT 127.0.0.1:8080 # наружу смотрит только Caddy с HTTPS
    echo "DOMAIN=$DOMAIN, стенд доступен только через Caddy (HTTPS)"
else
    set_env APP_PORT "$PORT"
    echo "APP_PORT=$PORT, HTTP без домена"
fi

FILES=(-f docker-compose.yml)
[ -n "$DOMAIN" ] && FILES+=(-f deploy/docker-compose.prod.yml)
[ "$BUILD" -eq 0 ] && FILES+=(-f deploy/docker-compose.images.yml)
export IMAGES_OWNER="$OWNER" IMAGES_TAG="$TAG"

if [ "$BUILD" -eq 1 ]; then
    say "Сборка образов по одному (на одном ядре — 10–15 минут)"
    for service in simulator api frontend; do
        run docker compose "${FILES[@]}" build "$service"
    done
else
    say "Готовые образы ghcr.io/$OWNER/alfa-hakaton-{simulator,api,frontend}:$TAG"
    if ! run docker compose "${FILES[@]}" pull; then
        cat >&2 <<MSG

Не удалось скачать образы. Возможные причины:
  - пакеты в GitHub Container Registry ещё закрыты: откройте https://github.com/$OWNER?tab=packages и у каждого из
    alfa-hakaton-api, alfa-hakaton-simulator, alfa-hakaton-frontend выберите Package settings → Change visibility → Public;
  - образы с тегом «$TAG» ещё не опубликованы: проверьте workflow «Образы» на вкладке Actions репозитория;
  - с сервера нет доступа к ghcr.io.
Запасной путь — собрать образы на месте: sudo bash deploy/install.sh --build${DOMAIN:+ --domain $DOMAIN}
MSG
        exit 1
    fi
fi

say "Запуск"
run docker compose "${FILES[@]}" up -d --no-build --wait

if [ -n "$DOMAIN" ]; then
    LOCAL="http://127.0.0.1:8080"
    PUBLIC="https://$DOMAIN"
else
    LOCAL="http://127.0.0.1:$PORT"
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    PUBLIC="http://${IP:-<адрес сервера>}$([ "$PORT" = 80 ] || echo ":$PORT")"
fi

say "Проверка"
if [ "$DRY_RUN" -eq 0 ]; then
    for _ in $(seq 1 30); do
        curl -fsS "$LOCAL/api/health" >/dev/null 2>&1 && break
        sleep 2
    done
    printf 'GET %s/api/health → ' "$LOCAL"
    curl -fsS "$LOCAL/api/health" || { echo "стенд не отвечает, смотрите: docker compose ${FILES[*]} logs --tail=100" >&2; exit 1; }
    echo
fi

UPDATE_CMD="git pull && sudo bash deploy/install.sh${DOMAIN:+ --domain $DOMAIN}$([ -n "$DOMAIN" ] || [ "$PORT" = 80 ] || echo " --port $PORT")$([ "$BUILD" -eq 1 ] && echo ' --build')$([ "$TAG" = latest ] || echo " --tag $TAG")"
cat <<MSG

Стенд запущен: $PUBLIC
$( [ -n "$DOMAIN" ] && echo "  Сертификат Let's Encrypt выпускается при первом обращении — первая загрузка может занять до минуты." )
  Вход: клиент veter, аналитик analyst, администратор admin — пароль admin (все учётные записи в README)
  Сброс демо-данных:  docker compose ${FILES[*]} exec api python -m app.seed --reset
  Логи:               docker compose ${FILES[*]} logs -f --tail=100
  Обновление:         $UPDATE_CMD
  Межсетевой экран:   sudo ufw allow 22,80,443/tcp && sudo ufw enable   (если ufw ещё не настроен)
MSG
