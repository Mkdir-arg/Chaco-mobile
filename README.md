# DATAÑACH — PWA de relevamientos

Aplicación de campo instalable desde el navegador, construida con React Native,
React Native Web y Expo. Descarga los relevamientos del usuario territorial,
permite guardar capturas y adjuntos sin conexión y sincroniza contra la API Django
existente cuando vuelve la conectividad.

**La entrega web es un build estático servido por Nginx.** No necesita Expo, Node
ni un servidor de aplicación en ejecución dentro del contenedor final. El backend
sigue siendo Chaco; este repositorio no agrega otro backend.

Repositorio: [Mkdir-arg/Chaco-mobile](https://github.com/Mkdir-arg/Chaco-mobile).
Ejecutar todos los comandos desde su raíz, independientemente de dónde esté
clonado. Tiene historial, ramas y CI propios; no es una carpeta del backend.
La rama de entrega a test es `test`.

- [Despliegue con Docker](#despliegue-estático-con-docker--ticket-213472026)
- [Configuración del backend](#configuración-del-backend)
- [Desarrollo local](#desarrollo-local)
- [Instalación y funcionamiento offline](#instalación-y-funcionamiento-offline)
- [Validación](#validación)
- [Compilación nativa opcional](#compilación-nativa-opcional)

## Tecnologías del repositorio

Estas son las versiones declaradas actualmente, no una lista de las últimas
versiones disponibles. Cambiar a PWA no implica reemplazar React Native o Expo.

| Componente | Uso actual |
|---|---|
| React 19.1, React Native 0.81.5, React Native Web 0.21 | Interfaz compartida y renderizado en navegador |
| Expo SDK 54 y Metro | Desarrollo y export estático web |
| Node.js 22.14.0 y npm | Compilación y CI; no son el servidor del contenedor final |
| Nginx `stable-alpine` | Hosting estático del contenedor, puerto 8080 |
| Service worker y manifiesto web | Arranque offline, actualización e instalación PWA |
| Expo SQLite / WebAssembly / OPFS | Persistencia de datos y cola offline en web |
| Async Storage | Sesión web y preferencias; en web utiliza almacenamiento del navegador |
| NetInfo | Cambios de conectividad |
| ZXing | Lectura web QR/PDF417 incluida en el bundle, sin CDN |
| Playwright | Pruebas en Chromium de persistencia y recuperación offline |

El código conserva soporte nativo Android/iOS. Secure Store, plugins nativos y EAS
corresponden a esa distribución opcional, no al despliegue PWA.

## Despliegue estático con Docker — ticket 21347/2026

El sitio de test acordado es **https://datanach-app.ecomdev.ar/**. La API permanece
**https://datanach.ecomdev.ar/**. El contenedor solo sirve archivos estáticos con
Nginx: no ejecuta Expo/Node en producción ni incorpora otro backend o un proxy a Django.

La imagen se construye desde la raíz del repositorio:

```sh
docker build -t chaco-mobile:pwa-test .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e URL_backoffice=https://datanach.ecomdev.ar \
  chaco-mobile:pwa-test
```

| Configuración | Test | Producción |
|---|---|---|
| Sitio PWA | `https://datanach-app.ecomdev.ar/` | A confirmar por infraestructura |
| `URL_backoffice` | `https://datanach.ecomdev.ar` | `https://datanach.chaco.gob.ar` |
| Puerto del contenedor | `8080` | `8080` |
| Health check | `GET /healthz` → `200 ok` | Igual |

`URL_backoffice` se pasa **al arrancar el contenedor**, con ese nombre y mayúsculas
exactos. No requiere reconstruir la imagen. El entrypoint valida un origen HTTPS
sin rutas, credenciales ni parámetros y genera `/runtime-config.js`, cargado antes
del bundle. Esta configuración tiene prioridad sobre `EXPO_PUBLIC_DJANGO_API_URL`;
la variable de Expo sigue disponible para desarrollo local y builds nativos.
Los archivos `.env*` locales, incluyendo la IP de desarrollo, se excluyen del
contexto Docker. No se debe incluir secretos en la configuración pública de la PWA.

El service worker obtiene la configuración con red primero y conserva la última
copia para arrancar offline. Las respuestas de la API y los tokens no se guardan
en el caché del service worker. SQLite y la cola siguen siendo la persistencia de
las capturas y adjuntos.

### Configuración que debe realizar infraestructura

- Crear DNS e ingress HTTPS con certificado válido para el sitio PWA; el TLS
  termina en el ingress y el servicio interno apunta al puerto HTTP `8080`.
- Conservar las cabeceras `Cross-Origin-Opener-Policy: same-origin` y
  `Cross-Origin-Embedder-Policy: require-corp`, también en HTML, JS, workers,
  archivos WASM y respuestas recuperadas de un caché intermedio. Nginx las envía.
- Conservar el fallback SPA: una ruta de pantalla sin archivo devuelve
  `index.html`. Un JS/WASM inexistente y `/api/` devuelven 404 en este contenedor;
  nunca se sirven como HTML de la app.
- No cachear `/runtime-config.js`; revalidar `index.html`, `sw.js`, manifiesto e
  íconos. Solo los bundles versionados bajo `/_expo/static/` usan caché inmutable.
- En **Django HML**, agregar `https://datanach-app.ecomdev.ar` a
  `DJANGO_CORS_ALLOWED_ORIGINS`. El middleware `ApiCorsMiddleware` del backend ya
  admite esa lista; comprobar OPTIONS y POST sobre `/api/becas/`, con credenciales
  y headers `Authorization` y `Content-Type`. El WAF/ingress tampoco debe bloquear
  OPTIONS, sustituir JSON por HTML ni quitar los headers CORS.
- Verificar el mismo permiso de origen en producción cuando se confirme su dominio.

El último punto es necesario: **publicar el estático en el dominio nuevo no arregla
por sí solo CORS**. La app consulta directamente al Django indicado por
`URL_backoffice`; no hay un proxy oculto en esta imagen. La inicialización del WAF
puede solicitar la raíz del backend antes del login; revisar también sus cookies
entre los subdominios del mismo ambiente.

## Configuración del backend

La PWA y Django se publican en dominios distintos. No confundir la URL del sitio
instalable con la URL de la API:

| Ambiente | Sitio PWA | Backend Django |
|---|---|---|
| Test | `https://datanach-app.ecomdev.ar` | `https://datanach.ecomdev.ar` |
| Producción | A confirmar por infraestructura | `https://datanach.chaco.gob.ar` |

`src/config/apiConfig.js` resuelve la dirección en este orden:

1. **PWA en Docker:** `URL_backoffice`, inyectada en `/runtime-config.js` al iniciar
   el contenedor. Tiene prioridad y permite cambiar el backend sin recompilar.
2. **Desarrollo local / build sin configuración runtime / nativo:**
   `EXPO_PUBLIC_DJANGO_API_URL`, leída por Expo durante el desarrollo o compilación.
3. `expo.extra.djangoApiUrl` en `app.json`, cuyo fallback actual es el backend de test.
4. Solo si tampoco existe esa configuración, se intenta derivar una dirección local.

Ejemplo de `.env.local` para trabajar contra el backend de test:

```dotenv
EXPO_PUBLIC_DJANGO_API_URL=https://datanach.ecomdev.ar
```

Para usar Django local, reemplazarla por `http://localhost:8000` desde la misma
computadora o por la IP real de esa computadora desde otro dispositivo. `localhost`
en un teléfono identifica al teléfono. Reiniciar Expo con `--clear` o reconstruir
el export después de cambiar la variable de compilación.

El backend debe publicar `/api/becas/`, admitir el hostname de la propia API en
`DJANGO_ALLOWED_HOSTS` y autorizar el origen de la PWA en
`DJANGO_CORS_ALLOWED_ORIGINS`. No alcanza con que el dominio PWA tenga certificado:
OPTIONS, JSON, multipart y cookies deben atravesar el WAF/ingress correctamente.
El origen de la PWA no se agrega a `ALLOWED_HOSTS` salvo que Django también atienda
ese hostname.

### Sesión, permisos y operaciones

La app inicia sesión mediante `POST /api/becas/auth/token/`. Django exige un usuario
activo con capacidad `becas.campo` y responde con `token`, `user_id` y `username`.
Las siguientes solicitudes incluyen `Authorization: Token <token>`.
La sesión de la PWA se guarda mediante Async Storage; la distribución nativa usa
Secure Store con fallback a Async Storage. No se debe dar por compartida la sesión
del backoffice con la app.

Django filtra los relevamientos y formularios por territorial. Instalar la PWA no
habilita acceso por sí solo; el usuario necesita asignaciones en el backend.
La identidad se consulta a Django, que resuelve padrón/Base de Personas; la PWA no
se conecta directamente a esas integraciones externas.

| Método y ruta | Operación |
|---|---|
| `POST /api/becas/auth/token/` | Login |
| `GET /api/becas/relevamientos/` | Agenda del territorial |
| `GET /api/becas/relevamientos/{id}/` | Detalle y definición del formulario |
| `POST /api/becas/relevamientos/{id}/iniciar/` | Iniciar relevamiento |
| `GET/POST /api/becas/relevamientos/{id}/formularios/` | Listar o crear capturas |
| `POST /api/becas/relevamientos/{id}/finalizar/` | Finalizar relevamiento |
| `POST /api/becas/relevamientos/{id}/reabrir/` | Reabrir relevamiento |
| `GET/PATCH /api/becas/formularios/{id}/` | Consultar o editar formulario |
| `GET/POST /api/becas/formularios/{id}/adjuntos/` | Adjuntos |
| `POST /api/becas/personas/consultar/` | Consulta de identidad |

Los adjuntos se envían como multipart; los demás cuerpos normalmente como JSON.

## Desarrollo local

Requisitos: Node.js 22.14.0 o superior dentro de la rama 22, npm y acceso al backend
que se quiera probar. Para la PWA no se necesita Expo Go, Android Studio ni EAS.

```sh
git clone --branch test https://github.com/Mkdir-arg/Chaco-mobile.git
cd Chaco-mobile
npm ci
npm run web -- --clear
```

Configurar `.env.local` antes de iniciar. `npm run web -- --host lan` permite
revisar la interfaz desde la IP de la computadora y el puerto que indique Expo,
si la red y el firewall lo permiten. Una IP privada por HTTP no habilita todas las
capacidades PWA: para cámara, instalación y persistencia web completa en teléfonos
se necesita un contexto HTTPS válido.

Para probar el export de producción en la misma computadora:

```sh
npm run build:web
npm run serve:web
```

Abrir **http://localhost:4173**. El servidor de vista previa escucha solo en loopback
y aplica las cabeceras de aislamiento. La prueba offline se hace sobre este export;
Metro de desarrollo no registra el service worker de producción.

## Instalación y funcionamiento offline

Publicar la app en la raíz de su dominio y con HTTPS válido. SQLite web necesita
OPFS, WebAssembly y SharedArrayBuffer, además de estas cabeceras:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

El Dockerfile ya configura Nginx para enviarlas. `public/_headers` sirve para hosts
que admitan ese formato; otros servidores deben configurarlas expresamente.
Los archivos WASM deben servirse como `application/wasm`.

En Android se instala desde Chrome; en iPhone/iPad, desde Safari usando Compartir
→ Agregar a inicio. El login muestra un instructivo por dispositivo que puede
cerrarse y reabrirse. Al abrir la app en modo instalado no aparece el instructivo.
Una pestaña normal no permite determinar de forma universal si ya existe otra
instalación en el dispositivo.

- La primera carga, el primer login y la descarga de asignaciones requieren conexión.
- El service worker precarga código, fuentes, íconos, imágenes, lector y SQLite/WASM.
  `/runtime-config.js` usa red primero con recuperación desde caché al estar offline.
- Las capturas, datos del formulario y cola se persisten en SQLite/OPFS. En web los
  adjuntos se convierten a data URL y se guardan con la captura y su operación,
  evitando referencias `blob:` que se pierdan al cerrar. Ocupan aproximadamente un
  tercio más que el archivo binario. En nativo se copian al filesystem de la app.
- La cola conserva propietario, UUID, fecha y versión. Con la app abierta, sincroniza
  al iniciar sesión, periódicamente, al recuperar conexión o por solicitud del usuario.
  Un 401 conserva pendientes y pide volver a entrar con el mismo usuario; un alta
  aceptada no se repite por tener un adjunto pendiente.
- La app solicita almacenamiento persistente, pero el navegador decide si lo concede.
  Borrar los datos del sitio puede eliminar capturas todavía no sincronizadas.
  Solo una captura guardada entra en la cola; un formulario abierto sin guardar
  no sobrevive al cierre.
- Las actualizaciones esperan al cierre de las ventanas; no recargan una captura
  en curso. El navegador puede suspender una PWA cerrada: hay que reabrirla para
  asegurar el envío de pendientes.
- El APK y la PWA tienen almacenamiento independiente. Sincronizar el APK antes
  de cambiar de distribución; instalar la PWA no migra los datos del APK.

## Validación

El workflow `.github/workflows/pr-mobile.yml` valida pushes y PRs hacia `main` y
`test`: suite Node, export PWA, prueba Chromium, build Docker, prueba del contenedor
y Expo Doctor. Usa Node 22.14.0.

```sh
npm ci
npm test
npx expo-doctor
npm run build:web
npx playwright install chromium
npm run test:web
docker build -t chaco-mobile:pwa-test .
node tests/docker-smoke.cjs chaco-mobile:pwa-test
```

Las pruebas de servicios usan SQLite en memoria y HTTP simulado. La prueba de
Chromium utiliza SQLite/OPFS real y cubre captura con archivo offline, recarga,
cierre y reapertura, multipart, 401 y reanudación sin duplicar el alta, además del
modal por dispositivo y la prioridad de la configuración runtime. Puede usarse
Chrome instalado definiendo `CHROME_PATH` con su ejecutable.

`npm run test:web` genera `dist-browser/` con hooks de prueba: **no se publica**.
`npm run build:web` genera `dist/` sin esos hooks. Las pruebas de contenedor usan
puertos efímeros de loopback para comprobar rutas SPA, 404 de recursos, cabeceras,
MIME WASM, caché y URLs de test/producción sobre la misma imagen.

Antes de dar un despliegue por operativo, validar con la API real y los teléfonos
objetivo: login, descarga, cámara/DNI QR-PDF417, ubicación, instalación, guardado
sin señal, cierre/reapertura, sincronización y manejo de errores. Las pruebas
locales no validan CORS, cookies, certificados ni WAF del sitio desplegado.

## Estructura del repositorio

```text
Chaco-mobile/
├── Dockerfile, .dockerignore       # Build estático y contenedor Nginx
├── docker/                        # Hosting y configuración runtime
├── public/                        # Manifiesto, íconos y configuración pública
├── scripts/                       # Export PWA y vista previa local
├── .github/workflows/             # CI
├── App.js, index.js               # Inicio, proveedores, navegación y sincronización
├── app.json                      # Configuración Expo y fallback de API
├── src/components/               # UI compartida y variantes .web
├── src/config/                   # Branding y resolución del backend
├── src/screens/                  # Pantallas
├── src/services/                 # API, persistencia, cola y PWA
├── src/theme/                    # Tokens y tema
├── tests/                        # Pruebas de servicios, interfaz, navegador y Docker
├── assets/                       # Logos, imágenes y fuentes
└── eas.json, plugins/             # Distribución nativa opcional
```

La navegación activa vive en `App.js`, mediante `activeTab` y
`selectedRelevamientoId`. `src/navigation/` conserva una alternativa React Navigation
que no es el punto principal de navegación.

## Reglas funcionales de los relevamientos

### Capturas tardías y errores de sincronización (#634 y #667)

Cada caso conserva la fecha de captura y la versión del formulario utilizada.
Cuando el servidor acepta una captura después del cierre, el listado la indica
como «Sincronizado tarde». Si la gracia vence, el envío muestra «Avisá al
coordinador» y requiere una decisión del territorial; sincronizar no lo reenvía.

El detalle del relevamiento muestra «Envíos que requieren atención»:

- **Corregir:** abre el mismo formulario para un alta rechazada por sus datos;
  conserva UUID, fecha de captura, versión y archivos.
- **Exportar:** comparte un JSON con la operación y su motivo. En Android/iOS
  incluye los adjuntos disponibles como base64; la PWA también incluye el contenido disponible de sus archivos locales.
  Exportar conserva el envío fallido en la cola.
- **Descartar envío:** pide confirmación y libera el cierre, conservando la
  captura y los archivos locales.

Los adjuntos admiten JPG, JPEG, PNG, WEBP, HEIC, HEIF y PDF hasta 5 MB. Un rechazo
permanente de un archivo deja su motivo y permite intentar los demás. Un adjunto
repetido de un caso ya resuelto se descarta automáticamente con el motivo del
servidor. Las pausas, el cupo completo y el 401 conservan sus tratamientos propios.

Para validar en dispositivo: capturar sin señal, sincronizar dentro y fuera de las
24 h después del cierre; rechazar un adjunto con otros pendientes; corregir un alta
400; exportar y descartar una falla y comprobar que se completa el cierre.

### Vigencia con fecha y hora (#635)

La franja del relevamiento se interpreta y muestra en
`America/Argentina/Buenos_Aires`, aunque el teléfono use otra zona. Las fechas
antiguas sin hora conservan la apertura a las 00:00 y el cierre al final del día.
Inicio, agenda y detalle muestran la misma franja; a menos de dos horas del cierre
aparece «Cierra a las HH:mm». La pantalla actualiza esos límites sin recargar.

El servicio impide iniciar o guardar un caso nuevo fuera de la franja, también
sin señal y si se dejó abierto un formulario hasta después del cierre. Los casos
ya capturados conservan su fecha; pueden sincronizarse durante la gracia. Los
relevamientos vencidos con pendientes siguen disponibles en la agenda para
resolver sus envíos. Corregir una captura anterior conserva su fecha original.

Prueba en dispositivo: asignar de 08:00 a 14:00; verificar el bloqueo a las 07:59,
la apertura a las 08:00, el aviso después de las 12:00 y el bloqueo después de las
14:00. Repetir sin señal y con el teléfono en otra zona horaria. Un caso capturado
antes del cierre debe seguir en la cola después de las 14:00.

### Identidad territorial (#633 y #669)

La consulta de DNI y sexo envía el relevamiento abierto y conserva el origen
`padron` o `personas` informado por el servidor, tanto en identificación como en
los metadatos del caso. También se considera validada la lectura `scan`.
Un 404 con `fallecido: true` impide continuar y guardar ese DNI/sexo en la sesión,
incluso al intentar volver a escanearlo. Un 404 sin fallecimiento y un 502 permiten
carga manual; el 429 muestra el aviso específico del tope de consultas.
Validar en dispositivo las fuentes del padrón y Base de Personas, el bloqueo de
fallecidos y la carga manual tras alcanzar el tope. Las pruebas automatizadas
cubren el contrato HTTP y la clasificación de esas respuestas.


### Formularios del constructor (#348)

Cuando la API entrega `definicion_formulario.items`, la app usa sus grupos,
textos y preguntas en el orden recibido. El `orden` del catálogo no reemplaza
el orden del diseño. Reutiliza los controles de la app para campos, fechas,
selectores, búsqueda de opciones y archivos. Los vínculos de identidad se
precargan y quedan en solo lectura cuando la identidad está validada; contacto
y apoderado se completan dentro de los grupos del diseño.

Las condiciones se evalúan en vivo con el motor de `nodo-condiciones.js` portado
a `src/services/condiciones.js`. Un campo oculto no se exige ni se manda, incluidos
sus adjuntos. La condición del diseño determina cuándo aparece Apoderado; no se
impone la regla fija de menores al usar el constructor. Los textos se muestran
como texto plano, con enlaces HTTP/HTTPS tocables.

Cada captura nueva descarga la definición vigente si hay conexión. Sin señal
usa la copia descargada; sin copia pide conexión. Durante la captura y al corregir
un envío se conserva la definición local y la fecha original: no se reinterpreta
la carga al cambiar el diseño del servidor.

Con `acepta_respuestas: true`, se envían `respuestas` por clave y los adjuntos
referencian `clave` (también `cp-`). Se conserva el payload anterior para servidores
sin esa señal. No se permite enviar campos propios a un servidor que aún no los
acepta. Sin `items` se mantiene el formulario legacy.

La definición se guarda localmente en el dispositivo: al servidor se envía
`version_capturada`, no una foto `definicion`. Si el diseño cambió mientras el
agente estaba sin conexión, el servidor puede aceptar el caso y dejarlo observado
por diferencia de versión; no reconstruye el diseño anterior.

Prueba en HML: guardar un cambio de orden en el constructor, iniciar una captura
nueva con señal y verificar los grupos y preguntas; cambiar una respuesta que
oculta otra obligatoria; repetir una captura offline y sincronizar tras cambiar
la versión. Las capturas ya pendientes deben conservar la definición con la que
se hicieron.


## Compilación nativa opcional

<details>
<summary>Android/iOS con Expo y EAS — no requerido para desplegar la PWA</summary>

El proyecto conserva sus configuraciones nativas. Estos comandos generan
instaladores, no el sitio estático y no reemplazan `npm run build:web` o Docker.

| Perfil de `eas.json` | Resultado / uso | Backend configurado |
|---|---|---|
| `development` | Cliente de desarrollo interno | Variable de build o fallback de `app.json` |
| `preview` | APK interno de test | `https://datanach.ecomdev.ar` |
| `production` | Build de tienda; Android AAB por defecto | `https://datanach.chaco.gob.ar` |
| `production-apk` | APK interno de producción | `https://datanach.chaco.gob.ar` |

La cuenta Expo debe tener acceso al proyecto indicado en `app.json`. El package
Android actual es `com.pablocao.relevamientochaco`. Mantener package y firma para
actualizar instalaciones existentes.

```sh
npx eas-cli@latest login
npx eas-cli@latest project:info
npx eas-cli@latest build --platform android --profile preview
npx eas-cli@latest build:list --platform android --status finished --limit 5
```

Para compilar Android nativo localmente, `npm run android` requiere Android
Studio/SDK. `npm start` inicia Expo y puede usarse con un cliente compatible;
no es el servidor de producción de la PWA. El plugin
`plugins/withAndroidNetworkSecurityConfig.js` bloquea HTTP en Android: usar HTTPS
para el backend de un APK, incluso durante una prueba local.

</details>
