# DATAÑACH — aplicación móvil

Aplicación móvil de relevamientos construida con React Native y Expo. Se conecta con la API de Django, permite trabajar sin conexión y sincroniza los datos pendientes cuando vuelve a haber internet.

> **Repositorio independiente:** este código vive en [Mkdir-arg/Chaco-mobile](https://github.com/Mkdir-arg/Chaco-mobile). Puede estar clonado dentro del directorio del sistema Chaco por comodidad, pero tiene su propio historial Git, remoto, ramas, pull requests y pipeline. Todos los comandos de este documento se ejecutan desde la raíz de **Chaco-mobile** y no desde el repositorio del backend.

## Tecnologías principales

- React Native 0.81 y Expo SDK 54.
- React 19.
- EAS Build para generar instaladores Android.
- SQLite para datos locales y cola de sincronización.
- Secure Store para guardar el token de sesión en el dispositivo.
- Async Storage para preferencias y compatibilidad con datos locales anteriores.
- NetInfo para detectar cambios de conectividad.

## Arquitectura

```text
Chaco-mobile/                       # Raíz de este repositorio
├── .github/workflows/             # Integración continua del repositorio móvil
├── App.js                         # Composición general, sesión, pantallas y sincronización
├── index.js                       # Punto de entrada de Expo
├── app.json                       # Identidad, permisos, API y plugins nativos
├── eas.json                       # Perfiles de compilación de EAS
├── assets/                        # Iconos, logos e imágenes
├── plugins/                       # Configuración nativa adicional de Android
└── src/
    ├── components/                # Componentes visuales reutilizables
    ├── config/                    # URL de la API y branding
    ├── context/                   # Estado global de autenticación y tema
    ├── navigation/                # Navegación reutilizable
    ├── screens/                   # Pantallas y flujos de usuario
    ├── services/                  # API, persistencia local y sincronización
    ├── theme/                     # Colores, tipografías y tokens visuales
    └── utils/                     # Utilidades generales
```

### Flujo de la aplicación

`App.js` monta los proveedores de autenticación y tema. Mientras se recupera la sesión muestra el splash; sin una sesión válida muestra el login y, una vez autenticado, habilita Inicio, Relevamientos, el detalle y el panel de configuración.

La navegación principal se controla actualmente desde `App.js` mediante estado (`activeTab` y `selectedRelevamientoId`). El directorio `src/navigation/` contiene una alternativa basada en React Navigation, pero no es el punto principal de navegación usado por `App.js`.

## Conexión con la webapp Chaco

La app móvil y la webapp son repositorios y aplicaciones independientes. **No comparten código, sesión del navegador ni acceso directo a la base de datos.** La integración se realiza por HTTP contra la API REST que expone el backend Django de Chaco bajo `/api/becas/`.

```text
App móvil (Chaco-mobile)
        │
        │ HTTPS + JSON/multipart
        │ Authorization: Token <token>
        ▼
API Django (webapp Chaco) ──────► Base de datos y archivos del backend
        ▲
        │
Backoffice web ─────────────────► administra asignaciones y revisa resultados
```

En términos funcionales, el backoffice crea y asigna relevamientos a un usuario territorial. La app inicia sesión con ese usuario, descarga únicamente sus relevamientos, permite completar formularios —incluso sin conexión— y envía formularios y adjuntos a la misma webapp. Los resultados sincronizados quedan disponibles en el backoffice para continuar su gestión y revisión.

### Configuración de la URL

`src/config/apiConfig.js` resuelve la URL base primero desde la variable de build
`EXPO_PUBLIC_DJANGO_API_URL` y usa `expo.extra.djangoApiUrl` de `app.json` sólo como
fallback local/testing. La URL fallback actual es:

```json
"extra": {
  "djangoApiUrl": "https://datanach.ecomdev.ar"
}
```

Cada ruta se construye agregándola a esa base; por ejemplo, el login termina llamando a `https://datanach.ecomdev.ar/api/becas/auth/token/`. Como no se especifica un puerto, se usa el puerto estándar 443 para HTTPS.

Cada pipeline debe definir `EXPO_PUBLIC_DJANGO_API_URL` con el host del ambiente. Así
login, API y el enlace «Olvidé mi contraseña» usan siempre el mismo backend sin tocar
el código ni reconstruir URLs manualmente. Por ejemplo:

```powershell
$env:EXPO_PUBLIC_DJANGO_API_URL = "https://hml.ejemplo.gob.ar"
npx expo export --platform web
```

Antes de generar el APK, la variable (o, en su ausencia, `djangoApiUrl`) debe apuntar
al entorno correcto:

| Entorno | Ejemplo | Condición |
|---|---|---|
| Desarrollo local | `http://192.168.1.20:8000` | Teléfono y servidor en una red que permita llegar a esa IP y puerto |
| QA | `https://datanach.ecomdev.ar` | Servidor de prueba actual del equipo |
| Producción | `https://datanach.chaco.gob.ar` | Dominio público, certificado TLS válido y API desplegada |

No usar `localhost` en un teléfono físico: allí `localhost` identifica al propio teléfono, no a la computadora que ejecuta Django. Para una instalación fuera de la red local se necesita una URL accesible desde internet o desde la VPN institucional. El plugin `plugins/withAndroidNetworkSecurityConfig.js` bloquea HTTP en Android y configura los dominios HTTPS de QA y producción. Para probar un backend local en Android se necesita HTTPS; el ejemplo HTTP es válido para web.

### Autenticación y permisos

1. La app envía usuario y contraseña como JSON a `POST /api/becas/auth/token/`.
2. Django valida las credenciales y exige la capacidad `becas.campo`.
3. La API responde con `token`, `user_id` y `username`.
4. La app guarda el token en Secure Store en Android/iOS —Async Storage en web—.
5. Las siguientes peticiones incluyen `Authorization: Token <token>`.

El backend filtra los datos por el usuario autenticado. Un territorial solo puede consultar y modificar relevamientos que le fueron asignados y los formularios asociados a ellos. Compartir un APK no otorga acceso por sí solo: cada operador necesita un usuario habilitado en la webapp con la capacidad correspondiente.

### Operaciones utilizadas

`src/services/becasApi.js` centraliza autenticación, peticiones JSON y carga multipart. `src/services/relevamientoService.js` consume principalmente estas operaciones del backend:

| Método y ruta | Uso desde la app |
|---|---|
| `POST /api/becas/auth/token/` | Iniciar sesión y obtener el token |
| `GET /api/becas/relevamientos/` | Descargar los relevamientos del territorial |
| `GET /api/becas/relevamientos/{id}/` | Descargar definición y detalle |
| `POST /api/becas/relevamientos/{id}/iniciar/` | Pasar un relevamiento asignado a curso |
| `GET/POST /api/becas/relevamientos/{id}/formularios/` | Listar o crear formularios |
| `POST /api/becas/relevamientos/{id}/finalizar/` | Finalizar el relevamiento |
| `POST /api/becas/relevamientos/{id}/reabrir/` | Reabrir un relevamiento finalizado |
| `GET/PATCH /api/becas/formularios/{id}/` | Consultar o actualizar un formulario propio |
| `GET/POST /api/becas/formularios/{id}/adjuntos/` | Listar o subir archivos y fotografías |
| `POST /api/becas/personas/consultar/` | Validar el DNI mediante Gran Base/Base de Personas |

Los archivos se envían como `multipart/form-data`; el resto de los cuerpos se intercambia normalmente como JSON. La app no se conecta directamente con RENAPER: solicita la consulta a Django y el backend realiza la integración externa.

### Requisitos del backend

Para aceptar conexiones de la app, el despliegue Django debe:

- Publicar las rutas `/api/becas/` y disponer de `rest_framework.authtoken`.
- Permitir el dominio o IP en `DJANGO_ALLOWED_HOSTS`.
- Tener usuarios territoriales activos con la capacidad `becas.campo` y relevamientos asignados.
- Exponer también el almacenamiento de adjuntos según la configuración del entorno.
- Incluir el origen en `DJANGO_CORS_ALLOWED_ORIGINS` si se ejecuta la variante web de Expo desde otro origen.

CORS afecta principalmente a la variante web ejecutada en un navegador. Una app Android nativa no aplica la política CORS del navegador, aunque igualmente necesita conectividad, DNS, TLS y permisos correctos en el servidor.

### Funcionamiento offline y sincronización

`src/services/relevamientoService.js` concentra la lógica offline-first:

1. Descarga y guarda localmente los relevamientos asignados.
2. Persiste relevamientos y operaciones pendientes en SQLite.
3. Conserva los adjuntos en el almacenamiento local de la aplicación.
4. Procesa una cola de salida (`outbox`) cuando hay conexión.
5. Reintenta errores temporales con espera incremental y conserva los errores permanentes para su revisión.

La sincronización se ejecuta al iniciar una sesión, periódicamente mientras la app está activa, al recuperar conectividad y cuando el usuario la solicita manualmente.

## Ejecutar en desarrollo

### Requisitos

- Node.js LTS y npm.
- Un teléfono con Expo Go o un emulador Android.
- Acceso desde el dispositivo al backend Django.

Clonar y entrar al repositorio móvil:

```powershell
git clone https://github.com/Mkdir-arg/Chaco-mobile.git
cd Chaco-mobile
npm ci
npm start
```

Si el repositorio ya está clonado dentro de otro proyecto, abrir una terminal directamente en su carpeta `mobile`; esa carpeta es la raíz Git para todo el trabajo de la app. Los commits y pushes se realizan allí y se envían a `Mkdir-arg/Chaco-mobile`, no al remoto del backend.

Expo mostrará un código QR. En Android, abrir Expo Go y escanearlo. La computadora y el teléfono deben poder comunicarse por la misma red.

Otros comandos disponibles:

```powershell
npm run android   # Compilación nativa local; requiere Android Studio/SDK
npm run web       # Ejecuta la variante web
```

Si el teléfono no llega a Django, comprobar que la URL de `djangoApiUrl` sea correcta, que el servidor escuche en una interfaz accesible y que el firewall permita el puerto correspondiente.

### Validación continua

El workflow `.github/workflows/pr-mobile.yml` se ejecuta en cada pull request y push a `main`. Instala las dependencias con Node.js 22.14.0, ejecuta `npm test` y valida el proyecto mediante Expo Doctor. Antes de subir cambios se puede correr la misma validación localmente:

```powershell
npm test
npx expo-doctor
```

## Generar un enlace para descargar en Android

El perfil `preview` de `eas.json` genera un **APK de distribución interna**. Ese es el formato que se puede descargar desde un enlace e instalar directamente en un teléfono Android.

### 1. Instalar e iniciar sesión en EAS

```powershell
npm install --global eas-cli
eas login
```

También se puede evitar la instalación global usando `npx eas-cli@latest` en lugar de `eas` en los comandos siguientes.

El proyecto ya tiene un `projectId` de EAS en `app.json`, por lo que normalmente no hace falta volver a ejecutar `eas init`. La cuenta utilizada debe tener acceso a ese proyecto de Expo.

### 2. Revisar la configuración antes de compilar

- Confirmar la URL de Django en `app.json`.
- Confirmar el identificador Android: `com.pablocao.relevamientochaco`.
- Confirmar que se está trabajando en el repositorio `Mkdir-arg/Chaco-mobile` y guardar allí todos los cambios que deban formar parte de la versión.
- Verificar la sesión y el proyecto con `eas whoami` y `eas project:info`.

### 3. Generar el APK

```powershell
eas build --platform android --profile preview
```

EAS sube el código, compila la aplicación y, al finalizar, imprime una URL de la página del build. Esa página contiene el botón para descargar el APK y se puede compartir con las personas que deban instalarlo.

Para recuperar el enlace más tarde:

```powershell
eas build:list --platform android --status finished --limit 5
```

También se puede entrar al panel del proyecto en Expo, abrir **Builds**, elegir Android y seleccionar la compilación terminada.

### 4. Instalar desde el enlace

1. Abrir el enlace del build desde el teléfono Android.
2. Descargar el APK.
3. Autorizar, si Android lo solicita, la instalación desde esa fuente.
4. Abrir el archivo descargado e instalarlo.

Para publicar una nueva versión, repetir el build con el perfil `preview` y compartir el nuevo enlace. El enlace identifica una compilación concreta; no actualiza automáticamente las instalaciones anteriores.

## Compilación para Google Play

El perfil `production` está pensado para distribución en la tienda y genera normalmente un **AAB**, no un APK instalable desde un enlace:

```powershell
eas build --platform android --profile production
```

Luego puede enviarse a Google Play Console manualmente o, una vez configuradas las credenciales de la tienda, mediante:

```powershell
eas submit --platform android --profile production
```

El perfil de producción tiene `autoIncrement` habilitado, de modo que EAS incrementa el código de versión de Android en cada build.

## Perfiles de EAS disponibles

| Perfil | Uso | Resultado Android |
|---|---|---|
| `development` | Desarrollo con cliente nativo | Development build interno |
| `preview` | Pruebas y descarga directa | APK instalable mediante enlace |
| `production` | Publicación en Google Play | AAB de tienda |

## Diagnóstico rápido

- **El APK abre pero no inicia sesión:** revisar que `djangoApiUrl` sea accesible desde la red del teléfono.
- **El build no encuentra el proyecto:** ejecutar `eas login` con una cuenta que tenga acceso al `projectId` configurado.
- **EAS solicita credenciales Android:** permitir que EAS genere y administre el keystore, salvo que el equipo ya tenga uno oficial.
- **Una actualización no se instala:** conservar el mismo package y la misma firma; el perfil configurado con EAS debe reutilizar el keystore del proyecto.
- **Los datos no se sincronizan:** comprobar conectividad, sesión vigente y elementos pendientes desde el indicador de sincronización de la app.

## Pruebas de sesión y cola offline

Con Node 22.14 o superior, ejecutar `npm ci` y `npm test`. El CI utiliza Node
22.14.0. Las pruebas usan SQLite en memoria y simulan las respuestas HTTP; cubren
la expiración de sesión durante el alta y la subida de adjuntos, la conservación
de pendientes, el reenvío después del login y las respuestas 401 concurrentes.

Validación en dispositivo para #666: revocar el token con «Cerrar sesión de la app»
con casos pendientes, sincronizar, verificar que aparece el login y volver a entrar
con el mismo usuario. Los casos deben enviarse sin tocar «sincronizar».

## Capturas tardías y errores de sincronización (#634 y #667)

Cada caso conserva la fecha de captura y la versión del formulario utilizada.
Cuando el servidor acepta una captura después del cierre, el listado la indica
como «Sincronizado tarde». Si la gracia vence, el envío muestra «Avisá al
coordinador» y requiere una decisión del territorial; sincronizar no lo reenvía.

El detalle del relevamiento muestra «Envíos que requieren atención»:

- **Corregir:** abre el mismo formulario para un alta rechazada por sus datos;
  conserva UUID, fecha de captura, versión y archivos.
- **Exportar:** comparte un JSON con la operación y su motivo. En Android/iOS
  incluye los adjuntos disponibles como base64; en web conserva sus referencias.
  Exportar conserva el envío fallido en la cola.
- **Descartar envío:** pide confirmación y libera el cierre, conservando la
  captura y los archivos en el teléfono.

Los adjuntos admiten JPG, JPEG, PNG, WEBP, HEIC, HEIF y PDF hasta 5 MB. Un rechazo
permanente de un archivo deja su motivo y permite intentar los demás. Un adjunto
repetido de un caso ya resuelto se descarta automáticamente con el motivo del
servidor. Las pausas, el cupo completo y el 401 conservan sus tratamientos propios.

Para validar en dispositivo: capturar sin señal, sincronizar dentro y fuera de las
24 h después del cierre; rechazar un adjunto con otros pendientes; corregir un alta
400; exportar y descartar una falla y comprobar que se completa el cierre.

## Vigencia con fecha y hora (#635)

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


## Formularios del constructor (#348)

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

La definición se guarda solo en el celular: al servidor se envía
`version_capturada`, no una foto `definicion`. Si el diseño cambió mientras el
agente estaba sin conexión, el servidor puede aceptar el caso y dejarlo observado
por diferencia de versión; no reconstruye el diseño anterior.

Prueba en HML: guardar un cambio de orden en el constructor, iniciar una captura
nueva con señal y verificar los grupos y preguntas; cambiar una respuesta que
oculta otra obligatoria; repetir una captura offline y sincronizar tras cambiar
la versión. Las capturas ya pendientes deben conservar la definición con la que
se hicieron.
