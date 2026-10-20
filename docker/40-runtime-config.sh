#!/bin/sh
set -eu
# Public origin only: reject JS metacharacters, credentials, queries and paths.
# TLS is terminated by the platform ingress; this is the HTTPS Django origin.
case "${URL_backoffice:-}" in
    *[!A-Za-z0-9:./-]*)
        echo 'URL_backoffice contiene caracteres no permitidos.' >&2
        exit 1
        ;;
esac
if ! printf '%s' "${URL_backoffice:-}" | grep -Eq '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$'; then
    echo 'URL_backoffice debe ser un origen HTTPS válido, sin rutas ni credenciales.' >&2
    exit 1
fi
backend_origin="${URL_backoffice%/}"
printf 'window.__DATANACH_CONFIG__ = {"URL_backoffice":"%s"};\n' "$backend_origin" \
    > /usr/share/nginx/html/runtime-config.js
