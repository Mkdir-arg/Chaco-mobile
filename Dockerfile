# syntax=docker/dockerfile:1
FROM node:22.14.0-bookworm-slim AS build
WORKDIR /app
ENV CI=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web

FROM nginx:stable-alpine AS runtime
ENV URL_backoffice=https://datanach.ecomdev.ar
COPY docker/default.conf /etc/nginx/conf.d/default.conf
COPY docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
