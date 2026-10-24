FROM node:22.22.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:1.27.2-alpine
# Кому верить в X-Forwarded-For: по умолчанию никому (адрес клиента — адрес соединения).
# За Caddy на сервере задаётся в deploy/docker-compose.prod.yml
ENV TRUSTED_PROXY=127.0.0.1/32
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY nginx/ /etc/nginx/snippets/
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
