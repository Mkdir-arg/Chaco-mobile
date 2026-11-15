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
| expo-image-manipulator | Conversión a JPEG de las fotos de Emergencia en nativo (en web, canvas) |
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
activo que entre a algún módulo de la app y responde con `token`, `user_id`,
`username` y `modulos`. Las siguientes solicitudes incluyen
`Authorization: Token <token>`.

`modulos` dice a qué módulos entra el usuario, siempre en este orden:

| Módulo | Qué hace | Quién entra |
|---|---|---|
| `becas` | Relevamientos de Becas | Territorial con `becas.campo` |
| `dispositivos` | Relevamiento edilicio de Dispositivos | Agente con `inspeccion.relevar` en el programa Dispositivos |
| `emergencia` | Ingreso de familias, llegada de familias y recepción de kits | Agente territorial (`emergencia.relevar`), guardia de un dispositivo o administrador del programa Dispositivos |

Con un solo módulo se entra directo; con varios, la app muestra un selector y se
puede cambiar desde el menú. Un 403 `SIN_MODULO` saca el módulo de la sesión local.
En Emergencia ese código también significa que falta un permiso parcial, así que
antes se vuelve a pedir `GET /api/emergencia/perfil/`: el módulo se saca solo si el
perfil también responde 403 `SIN_MODULO`. El perfil se guarda en el teléfono para
arrancar sin red.

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
| `GET /api/emergencia/perfil/` | Accesos del módulo Emergencia |
| `POST /api/emergencia/personas/consultar/` | Consulta de identidad de Emergencia |
| `GET /api/emergencia/localidades/` | Localidades del Formulario 1 |
| `POST /api/emergencia/casos/` | Enviar una familia (multipart, idempotente) |
| `GET /api/emergencia/casos/mios/` | «Mis envíos» |
| `GET /api/emergencia/mis-dispositivos/` | Dispositivos de la guardia (`admite`, `recibe_kits`, pendientes y camas libres) |
| `GET /api/emergencia/dispositivos/{id}/entregas/?pendientes=1` | Entregas de kits por recibir |
| `GET /api/emergencia/entregas/{id}/` | Una entrega con sus líneas |
| `POST /api/emergencia/entregas/{id}/recibir/` | Recibir una entrega (multipart, idempotente, con conexión) |
| `GET /api/emergencia/dispositivos/{id}/buscar/?dni=` | Buscar a la familia por DNI (M2, con tope y `Retry-After`) |
| `POST /api/emergencia/derivaciones/{id}/aceptar/` | Aceptar la derivación y reservar camas (JSON, no idempotente) |
| `POST /api/emergencia/derivaciones/{id}/rechazar/` | Rechazar la derivación con motivo (JSON, no idempotente) |
| `GET/POST /api/emergencia/casos/{id}/integrantes/` | Integrantes de la familia y «Agregar persona» (idempotente) |
| `GET/PATCH /api/emergencia/casos/{id}/integrantes/{n}/` | Una persona con su ficha; completar las secciones 4 a 8 (JSON) |
| `GET /api/emergencia/dispositivos/{id}/plazas/?caso=` | Mapa de camas para elegir la de una persona |
| `POST /api/emergencia/casos/{id}/integrantes/{n}/confirmar/` | Confirmar a una persona con su ficha y su cama (JSON, idempotente) |
| `POST /api/emergencia/casos/{id}/alojar/` | «Familia alojada» con la sección 4 (JSON, no idempotente) |
| `POST /api/emergencia/casos/{id}/cerrar-diferencia/` | Cerrar el ingreso con diferencia (JSON, no idempotente) |
| `POST /api/emergencia/casos/{id}/cancelar-ingreso/` | Cancelar el ingreso (JSON, no idempotente) |
| `POST /api/emergencia/dispositivos/{id}/ingreso-directo/` | «Ingresar igual» sin derivación (JSON, idempotente, con conexión) |
| `POST /api/emergencia/dispositivos/{id}/avisar-mesa/` | «Avisar a la mesa» sin derivación (JSON, idempotente, con conexión) |

Los adjuntos se envían como multipart; los demás cuerpos normalmente como JSON.

Para Emergencia, `src/services/emergenciaApi.js` arma los pedidos de
`/api/emergencia/` (localidades, consulta de identidad, envío de familias, mis envíos,
mis dispositivos, recepción de kits y llegada de familias) con los nombres de campos del contrato
`docs/internal/contrato-app-emergencia.md` de Chaco-Back. Los envíos con fotos van en
un solo multipart (`uploadMultipart`, varios archivos). Emergencia acepta **solo
JPEG** de hasta 5 MB: `src/utils/jpeg.js` (`aJpeg`) convierte cualquier foto a JPEG de
hasta 3 MB, con canvas en web y `expo-image-manipulator` en nativo. Becas y
Dispositivos no cambian.

- En web, el JPEG que arma `aJpeg` vive en una `blob:` URL que retiene los bytes. La
  pantalla que lo use tiene que llamar a `liberarJpeg(asset)` cuando descarta la foto o
  cuando ya la envió o la guardó (después, esa uri deja de poder leerse). Con el asset
  original del selector o uno de nativo no hace nada.
- `enviarCaso` normaliza `relevado_en` (`Date` → ISO 8601 con el offset del teléfono; un
  texto pasa tal cual) y `fecha_nacimiento` (`DD/MM/AAAA`, `AAAA-MM-DD` o `Date` →
  `AAAA-MM-DD`). Una fecha inválida rechaza con `code: 'FECHA_INVALIDA'` y `campo`, sin
  mandar nada.

#### M1 · Ingreso de familias (desde 1.2.13)

El acceso «Ingreso de familias» (perfil con `relevar`) abre «Mis envíos» y, desde ahí,
el Formulario 1 (`EmergenciaFormulario1Screen`) en cuatro bloques: traslado y
responsable (DNI escaneado o consultado en `personas/consultar/`, alta mínima si no
figura), personas que ingresan juntas, quiénes necesitan asistencia, y ubicación y
fotos (dirección, localidad, GPS opcional y hasta dos fotos JPEG). Funciona sin señal:

- `src/services/emergenciaCola.js` usa su propia base `emergencia_offline.db` (no
  toca las de Becas ni Dispositivos). El borrador vive ahí y sobrevive a cerrar la
  app; su `uuid_cliente` nace con él y no cambia nunca. Las fotos pasan por `aJpeg`
  y se guardan como data URL en web o en `attachments/emergencia` en nativo; se
  borran al entregar o descartar.
- «Enviar» toma `relevado_en` en ese momento y pasa el borrador a la cola
  (`PENDING` → `IN_FLIGHT` → `DONE`). 201 y 200 cierran el envío y guardan el
  número de caso. Un 400 `VALIDACION` lo devuelve a borrador, con el mismo uuid y los
  errores por campo, para corregir y reenviar. Un 409 `UUID_EN_USO` queda como error
  permanente (no se reintenta ni se cambia el uuid). Un 403 `SIN_MODULO` vuelve a
  pedir el perfil y queda guardado sin reintentarse solo. 401 conserva la cola hasta
  volver a entrar; 429, 5xx, timeout y falta de red reintentan con backoff (hasta 8
  veces) respetando `Retry-After`. Un `IN_FLIGHT` de más de 2 minutos (proceso
  cerrado a mitad de envío) vuelve a la cola.
- La cola se sincroniza al entrar al módulo, cada 8 s y al recuperar conexión, solo
  mientras Emergencia está abierto; el Banner muestra los pendientes y su botón
  reintenta. Cerrar sesión desde Emergencia con envíos sin entregar avisa antes.
- La lista de localidades se guarda al entrar al módulo y se refresca una vez por día;
  el buscador funciona sin red. «Mis envíos» guarda la última lista del servidor para
  verla sin red.
- Las reglas de cliente (`src/utils/emergencia.js`) solo ayudan a cargar bien: las que
  valen son las del back.

#### M3 · Recepción de kits (desde 1.2.14)

El acceso «Recepción de kits» (perfil con `kits`) abre «mis dispositivos» filtrado a los
que tienen `recibe_kits`; con uno solo entra directo a sus entregas. La lista de entregas
pide `?pendientes=1` (en camino y preparadas) y muestra número, salida y un resumen de
ítems. La recepción (`EmergenciaRecibirEntregaScreen`) precarga lo enviado en un input
por línea (entero ≥ 0, `0` si no llegó nada), muestra faltantes y sobrantes, exige la
foto del remito (pasa por `aJpeg`; se suelta con `liberarJpeg` al cambiarla, enviarla o
salir) y admite una observación. Con diferencias, «Recibir» pide confirmación.

- **No se encola**: necesita conexión. Sin red (en web `navigator.onLine`, en nativo
  NetInfo) no se manda nada y la pantalla lo avisa.
- La lógica vive en `src/services/emergenciaKits.js` (normalizar, cantidades,
  diferencias, clasificación de errores y la recepción abierta). El multipart lleva
  `uuid_cliente`, `cantidades[<id del ítem>]` por cada línea (también las `0`), `remito`
  JPEG y `observacion` si hay; sale con el token de la sesión que abrió la recepción y con
  el tiempo máximo de la cola de M1 (`timeoutDelEnvio`).
- **Idempotencia**: el `uuid_cliente` nace al abrir la recepción y se guarda en
  AsyncStorage por usuario y entrega, con las cantidades y la observación (nunca la foto),
  así un cierre accidental no lo cambia. Si un envío queda **incierto** (red, timeout, 5xx,
  429, 401 o un rechazo desconocido: el pedido pudo haber llegado), nada se cambia
  (cantidades, observación ni foto) y «Reintentar» manda lo mismo con el mismo uuid, sin
  foto si ya no está (§12 no la pide en el reenvío); con `Retry-After` el botón espera. Un
  413, un 403 o un 400 sin `code: VALIDACION` no lo destraban (no dicen nada del pedido
  anterior); un 400 `VALIDACION` sí. El reenvío de un intento incierto va sin foto.
  «Verificar si llegó» (y, sola, al reabrir una incierta) consulta `GET entregas/{id}/`: si
  sigue `EN_CAMINO`/`PREPARADA`, el pedido no escribió y se destraba con el mismo uuid; si
  figura recibida, muestra lo registrado; cancelada o 404, se cierra; sin respuesta, sigue
  incierta. 200/201 la cierran, y si el back registró otras cantidades que las mandadas, se
  avisa.
- Mientras se manda no se puede volver (el `Banner` esconde la flecha).
- Errores: 409 con `estado_actual` muestra `detail` y vuelve a las entregas; si había un
  intento incierto o descartado y la entrega figura recibida, consulta `GET entregas/{id}/`
  y muestra lo registrado. 409 `UUID_EN_USO` solo deja seguir descartando el intento (uuid
  nuevo, lo cargado se conserva); es el único caso con «Descartar». 404 vuelve a «mis
  dispositivos» sin volver a entrar directo; 403 `SIN_MODULO` vuelve a pedir el perfil y va
  al inicio; 400 `VALIDACION` marca cada línea o el remito; 413 pide otra foto del remito.
- Una recepción incierta cuya entrega ya no figura pendiente no se borra en silencio: la
  lista de entregas consulta la entrega y avisa si quedó registrada (con lo recibido), si la
  mesa la canceló o si no se pudo confirmar; sin red se conserva para otra vez.

#### M2 · Llegada de familias, parte 1 (desde 1.2.16)

El acceso «Llegada de familias» (perfil con `llegadas`) abre «mis dispositivos» filtrado a los
que tienen `admite` (la misma pantalla de M3 con `modo="llegadas"`: cada fila dice las
derivaciones por aceptar y las camas libres; ese contador es el aviso de derivaciones nuevas, no
hay notificaciones). Con uno solo entra directo. De ahí:

- **Buscar** (`EmergenciaLlegadaBuscarScreen`, §13.2): DNI de 7 u 8 dígitos (se valida antes de
  pedir). `DERIVACION` pendiente abre la derivación; aceptada, los integrantes. `SIN_DERIVACION`
  muestra el `mensaje` del back y las camas libres, con «Ingresar igual» (solo con camas) y
  «Avisar a la mesa»; `ALOJADA`, el `mensaje` y, si viene, dónde y desde cuándo. El 429 deshabilita
  «Buscar» con la cuenta regresiva de `Retry-After`.
- **Derivación** (`EmergenciaDerivacionScreen`, §13.3 y §13.4): caso, prioridad, responsable,
  camas pedidas, vencimiento (una vencida se puede aceptar igual), la familia y sus necesidades.
  «Aceptar y reservar camas» sigue a los integrantes (con camas de menos, lo avisa); «Rechazar»
  pide el motivo (y qué pasó con «Otro») y confirma antes de mandar. Un 400 `plazas` se muestra
  en la pantalla.
- **Integrantes** (`EmergenciaIntegrantesScreen`, §13.5): «N de M confirmadas», «llegaron 8 sobre
  7», una fila por persona (cama, parentesco, «Ficha incompleta») y «Agregar persona» (confirma
  antes; idempotente: el uuid nace al tocar y el reintento manda el mismo). Con la familia alojada
  o el caso cerrado, solo lectura.
- Los cierres («Familia alojada», «Cerrar con diferencia», «Cancelar ingreso», según el contador,
  §13.9) y el ingreso sin derivación («Ingresar igual», «Avisar a la mesa», §13.10) son de la parte 3
  (más abajo).

Reglas (`src/services/emergenciaLlegadas.js`):

- **Con conexión, sin lectura guardada**: sin red (en web `navigator.onLine`, en nativo NetInfo)
  no sale ningún pedido y la pantalla lo avisa. Lecturas cortan a los 20 s y acciones a los 30 s.
- **Sesión fijada al abrir**: cada pantalla toma usuario y token al montarse. Si la sesión ya es otra,
  no sale ningún pedido de la anterior; si no, cada pedido sale con ese token (`becasRequest(path, { token })`: nunca con el de otra sesión, y su 401 cierra la sesión
  solo si sigue vigente). La respuesta que llega con otra sesión se descarta (y la de una búsqueda o
  una lectura que vuelve después de salir de la pantalla, también).
- «Agregar persona» guarda su `uuid_cliente` en AsyncStorage por usuario y caso hasta saber el
  resultado: volver, re-entrar o cerrar la app no lo cambian (el reintento no suma otra persona). Si
  ese reenvío devuelve una persona que ya estaba en la lista, se avisa que ya se había sumado; con la
  familia alojada o el caso cerrado, el pendiente se olvida.
- **El estado es el del servidor**: ante un 409 se muestra `detail` y se recarga por
  `estado_actual` (el 409 de M2 no trae `code`): `DERIVADO` vuelve a buscar sola por el DNI;
  `INGRESO_EN_CURSO` va a los integrantes, y `ALOJADO`/`CERRADO` a los integrantes en lectura;
  `EN_GESTION`, `NUEVO` u otro, a buscar de nuevo (el caso volvió a la mesa).
- **Aceptar y rechazar no son idempotentes**: si un envío queda incierto (red, timeout, 5xx o
  página del WAF) la pantalla ofrece «Reintentar»; si el reintento recibe 409 con el estado que
  esa acción produce (`INGRESO_EN_CURSO` al aceptar, el caso en la mesa al rechazar), es «se
  hizo» y se sigue. Un 400, 404 o 409 destraba el intento incierto; 429, 403 o sin red no.
- Mientras se acepta, se rechaza o se agrega una persona no se puede volver. 404 vuelve a «mis
  dispositivos» sin entrar directo; 403 `SIN_MODULO` vuelve a pedir el perfil y va al inicio.

#### M2 · Llegada de familias, parte 2 (desde 1.2.17)

En los integrantes, tocar una persona abre `EmergenciaFichaScreen` («Persona N»; volver lleva a los
integrantes, que se recargan). Sin confirmar se abre solo con el ingreso en curso; la ficha de una
confirmada, también con la familia alojada (con el caso cerrado, en lectura).

- **Confirmar** (§13.8, M2-4): el mínimo del Formulario 2 (§13.11): parentesco (con cuál si es
  «Otro»), DNI, nombre, apellido, sexo (F, M, X), fecha de nacimiento (con «aproximada»), teléfono,
  documento extraviado, las cinco preguntas de salud con «Sí»/«No» (`false` es respuesta; con
  medicación crítica, cuál y si tiene dosis) y el adulto responsable si la fecha dice menor de 16.
  La cama sale del mapa (§13.7): se propone la primera guardada para la familia
  (`RESERVADA_FAMILIA`); «Cambiar cama» muestra el mapa por sector, y solo se elige lo `elegible`
  (ocupada, fuera de servicio y reservada para otra persona quedan deshabilitadas). Las secciones 4
  a 8 se pueden cargar ahí mismo («Cargar ahora el resto de la ficha»).
- **Completar** (§13.6): una confirmada muestra «Ficha incompleta» y lo que falta, y deja cargar las
  secciones 4 a 8 (cada una con «Sin datos»). «Guardar ficha» manda por `PATCH` **solo las
  secciones que cambiaron** (cada sección que viene reemplaza a la guardada: así no pisa lo que otra
  guardia cargó en otra). Sin cambios no manda nada. **Dentro de una misma sección gana el último
  que guarda**: si dos guardias editan la misma sección a la vez, la segunda reemplaza a la primera
  (el back no versiona la ficha). El botón de sincronizar vuelve a leer a la persona y deja lo tocado
  encima.

Reglas (`src/services/emergenciaLlegadas.js`, `src/utils/fichaEmergencia.js`):

- **Validación antes de mandar**: lo que el back exige siempre (parentesco, DNI de 7 u 8 dígitos,
  las cinco preguntas respondidas, medicación crítica, adulto de un menor, la cama) y tipos y
  largos. Nombre, apellido, sexo y fecha **no** bloquean: con la persona en el legajo alcanza el
  DNI y el back completa; si no está, el 400 los marca en su campo. Cada 400 `VALIDACION` va al
  campo por su nombre plano (§13.8); `orden` y lo que no es un campo, a «Para corregir».
- **«Confirmar persona» es idempotente**: el `uuid_cliente` nace al mandar y se guarda en
  AsyncStorage por usuario, caso y persona hasta saber el resultado (como «Agregar persona»):
  volver, re-entrar o cerrar la app no lo cambian, y «Reintentar confirmar» manda el mismo. Se
  olvida con 2xx, 400, 404 y 409; se conserva con red, timeout, 5xx, página del WAF, 429 y 403. Si
  el reenvío devuelve a la persona en **otra** cama (la del primer envío, que había llegado), se
  avisa que quedó así.
- **Camas compartidas entre guardias**: un 400 `plaza` (otra guardia tomó la cama, o quedó fuera de
  servicio) se muestra en la cama, recarga el mapa y, si la elegida ya no sirve, propone otra
  guardada para la familia; no se reenvía solo. Sin ninguna elegible, lo dice y no deja confirmar
  (queda cerrar con diferencia, parte 3).
- **Guardar la ficha** no necesita uuid: repetir el `PATCH` deja lo mismo; tras un corte, «Reintentar
  guardar» manda lo mismo.
- **409** (otra guardia la confirmó, el caso se cerró o volvió a la mesa) va al router de §13.1; un
  404 vuelve a los integrantes (si el caso ya no es del dispositivo, su propio 404 sigue a «mis
  dispositivos»). Mientras se confirma o se guarda no se puede volver.
- **Borrador de la ficha en curso**: lo tipeado se guarda en el teléfono por usuario, caso, persona y
  modo, para no perderlo si se vuelve atrás, el router recarga o se cierra la app. No es lectura
  guardada ni cola: sin red la pantalla igual se bloquea. Al confirmar, guarda la ficha entera y la
  cama. Al completar, guarda **solo las secciones tocadas** y cómo estaban en el servidor al empezar:
  al recuperarlo se ponen sobre la ficha de ahora, y si otra guardia guardó una de esas secciones en
  el medio no se pone sola: se avisa y se elige («Recuperar lo mío» o «Quedarme con lo guardado»).
  «Descartar lo recuperado» vuelve a lo del servidor. Se borra al confirmar o guardar, ante un 404,
  409 o 403, cuando la persona ya figura confirmada, en el **logout**, cuando la sesión vence (401) y
  cuando el usuario pierde Emergencia (`emergenciaLimpieza`, desde `AuthContext`), y al entrar y al
  abrir el módulo, los de otro usuario y los vencidos (48 h). Un conflicto sin resolver también se
  guarda: al volver sigue siendo conflicto.
- Un campo que depende de otra respuesta (cuál parentesco, la medicación crítica, el detalle de las
  alergias) no se manda si esa respuesta no lo abre, y se limpia al cambiarla.

#### M2 · Llegada de familias, parte 3 (desde 1.2.18)

- **Cerrar el ingreso** (`EmergenciaCierreScreen`, §13.9): el botón de los integrantes abre el cierre
  que corresponde al contador (el título del Banner es el del cierre; volver lleva a los integrantes):
  - «Familia alojada» (M2-5, N de N): la sección 4, toda opcional: sector (del mapa de §13.7, se
    propone el de la mayoría de las camas de la familia; si el mapa no llega, se aloja sin sector),
    aula o dormitorio, «se entregó la tarjeta familiar» (con su número obligatorio) y quién recibe
    (vacío: el usuario).
  - «Cerrar con diferencia» (RN-3.9): motivo del catálogo (`QUEDO_CON_FAMILIARES`, `NO_LLEGO`,
    `DERIVADO_A_SALUD`, `OTRO`, que es también el de «no sabe su número de DNI») y qué pasó con «Otro».
  - «Cancelar ingreso»: motivo de texto (hasta 200). Libera todas las camas de la familia.
  Los tres confirman antes de mandar (diferencia y cancelar como acción destructiva) y dicen cuántas
  camas se liberaron. Alojada o con diferencia vuelve a los integrantes en lectura; cancelado, a
  buscar con el DNI (el caso volvió a la mesa).
- **Sin derivación** (`EmergenciaPuertaScreen`, §13.10, M2-6): «Ingresar igual» (solo con camas
  libres) y «Avisar a la mesa» abren el Formulario 1 de la puerta con el DNI buscado (fijo: para otra
  persona se vuelve a buscar; es la clave del envío pendiente): traslado, DNI,
  nombre, apellido, fecha de nacimiento, teléfono, documento extraviado, las seis cantidades, la
  asistencia y los avisos, dirección (opcional: vale la del dispositivo) y observaciones. Sin hora,
  fotos, GPS ni localidad. Nombre y apellido no bloquean (con la persona en el legajo alcanza el DNI;
  si no, el 400 los marca). Confirma antes de mandar. Ingresada, sigue a los integrantes del caso
  nuevo; avisada, vuelve a buscar. Un 400 `plazas` (las camas se ocuparon) pasa a «Avisar a la
  mesa» con lo cargado.

Reglas (`src/services/emergenciaLlegadas.js`):

- **Alojar, diferencia y cancelar no son idempotentes** (no llevan uuid): como aceptar y rechazar,
  un envío incierto ofrece «Reintentar» (sin volver a preguntar y con lo cargado fijo), y el 409 del
  reintento con el estado que esa acción produce es «se hizo»: `ALOJADO`/`CERRADO` para alojar y
  diferencia, `EN_GESTION`/`NUEVO` para cancelar. Se muestra el `detail` del servidor (puede haberlo
  hecho otra guardia; al alojar, además pide revisar los datos de alojamiento en la ficha, porque lo
  cargado puede no haberse guardado). Otro estado, o un 409 sin intento incierto, va al router de §13.1.
  Un 400 `non_field_errors` (la acción ya no corresponde al contador) se muestra en la pantalla.
- **Reintento de un cancelar incierto**: nunca se reenvía sin preguntar. Antes se releen los
  integrantes: con el caso ya en la mesa es «se hizo» sin reenviar; con el ingreso en otro estado o con
  personas confirmadas, no se reenvía y se vuelve a los integrantes. Si sigue en curso sin nadie
  confirmado no se puede saber si es el mismo ingreso o uno nuevo (el primer cancelar llegó, la mesa
  volvió a derivar acá y otra guardia aceptó): se vuelve a confirmar con el estado real («No sabemos si
  la cancelación llegó. El ingreso figura en curso, sin nadie confirmado. ¿Cancelarlo?», «Cancelar el
  ingreso» / «No») y solo con el «sí» se manda. **Arreglo de fondo pendiente en el back**: exponer el id
  de la derivación vigente en `GET …/integrantes/` y aceptar `derivacion` opcional en
  `POST …/cancelar-ingreso/`, con 409 si no es la última; así la app compara y no hace falta preguntar.
- **Ingresar igual y avisar a la mesa son idempotentes**: el `uuid_cliente` nace al mandar y se
  guarda con lo cargado en AsyncStorage por usuario, dispositivo y DNI hasta saber el resultado:
  volver, re-entrar o cerrar la app no lo cambian, y al volver a esa familia **solo** se ofrece
  reintentar ese envío con el mismo uuid (la otra acción, con otro uuid, crearía un segundo caso).
  Se olvida con 2xx, 400 y 409 `UUID_EN_USO`, con un 404 solo si el uuid es recién nacido (el back
  resuelve el alcance del dispositivo antes de mirar el uuid: con uno de antes, el primer envío pudo
  haber llegado), y cuando la búsqueda de ese DNI ya trae una derivación o la familia alojada. Se
  conserva con red, timeout, 5xx, página del WAF, 429 y 403. Si el reenvío devuelve el caso en otro
  estado (ya alojado, de vuelta en la mesa), se dice eso y no «ingreso en curso».
- **Datos personales de la puerta**: lo tipeado (y el DNI) se borra en el logout, con la sesión
  vencida o sin el módulo, al abrir el módulo con otro usuario y a las 48 h (`emergenciaLimpieza`).
  El uuid **no** se pierde: queda `{ uuid, accion, dispositivo, creado_en }` por usuario, bajo el
  SHA-256 de dispositivo y DNI, 7 días.
- **Excepción a la limpieza de datos personales**: esa huella SHA-256 de dispositivo+DNI **es un dato
  personal revertible** (con 10^8 DNI posibles se recupera por fuerza bruta) y se conserva a propósito
  hasta 7 días después del logout o del vencimiento **del mismo usuario**, para que su reintento no
  cree un caso duplicado. Cuando entra otro usuario (al iniciar sesión o al abrir el módulo) se borra
  junto con todo lo demás de los otros dueños: el uuid solo le sirve a quien lo creó (con otro usuario
  el back contesta `UUID_EN_USO`).
  Al volver a esa familia se ofrece solo «Reintentar», que manda el uuid y el DNI: el back busca el
  uuid antes de validar el Formulario 1, así que si el primero llegó devuelve el caso; si no, contesta
  400 (no se creó nada) y se vuelve a cargar el formulario.
- **Con conexión**: el contrato deja encolar el ingreso directo sin señal, pero en la app M2 se
  bloquea sin red (sin red no sale nada y se avisa); el reintento es a mano.
- 429 deja el botón en «Reintentar en N s» (`Retry-After`). 404 vuelve a «mis dispositivos»; 403
  `SIN_MODULO` vuelve a pedir el perfil y va al inicio. Mientras se manda no se puede volver.


> **Despliegue:** `expo-image-manipulator` es un módulo nativo. Desde 1.2.13 el
> Formulario 1 importa `src/utils/jpeg.js`: Android/iOS necesitan **un build nuevo**
> (EAS, ver «Compilación nativa opcional»): la app no tiene `expo-updates`, y un
> instalador viejo no trae el módulo. En la PWA (web) no aplica: usa canvas y sale con
> `npm run build:web`.

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
