# syntax=docker/dockerfile:1
FROM node:22.14.0-bookworm-slim AS build
WORKDIR /app
ENV CI=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web
# Precompresion para gzip_static: se paga una vez en el build y no por request.
# Va despues de build:web porque el sw.js nombra su cache con el hash de los bytes
# de los archivos originales; comprimir antes le agregaria los .gz a la precarga.
RUN find dist -type f -size +1k \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' \
         -o -name '*.webmanifest' -o -name '*.wasm' -o -name '*.svg' \) \
      ! -name 'runtime-config.js' ! -name '*.map' \
      -exec gzip -9 -k {} + \
    && find dist -name '*.js.gz' -size +100k -exec ls -lh {} +

FROM nginx:stable-alpine AS runtime
ENV URL_backoffice=https://datanach.ecomdev.ar
COPY docker/default.conf /etc/nginx/conf.d/default.conf
COPY docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
