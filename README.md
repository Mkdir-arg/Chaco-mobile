# Relevamiento Chaco — aplicación móvil

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

`src/config/apiConfig.js` resuelve la URL base desde `expo.extra.djangoApiUrl` de `app.json`. La URL actual es:

```json
"extra": {
  "djangoApiUrl": "http://10.5.6.209"
}
```

Cada ruta se construye agregándola a esa base; por ejemplo, el login termina llamando a `http://10.5.6.209/api/becas/auth/token/`. Como no se especifica un puerto, se usa el puerto estándar 80 para HTTP.

Antes de generar el APK, `djangoApiUrl` debe apuntar al entorno correcto:

| Entorno | Ejemplo | Condición |
|---|---|---|
| Desarrollo local | `http://192.168.1.20:8000` | Teléfono y servidor en una red que permita llegar a esa IP y puerto |
| QA | `https://qa.chaco.example` | Dominio accesible desde los dispositivos de prueba |
| Producción | `https://chaco.example` | Dominio público, certificado TLS válido y API desplegada |

No usar `localhost` en un teléfono físico: allí `localhost` identifica al propio teléfono, no a la computadora que ejecuta Django. Para una instalación fuera de la red local se necesita una URL accesible desde internet o desde la VPN institucional. El plugin `plugins/withAndroidNetworkSecurityConfig.js` habilita HTTP en Android para el entorno actual, pero producción debería usar HTTPS.

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
| `POST /api/becas/renaper/consultar/` | Consultar identidad mediante la integración del backend |

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

El workflow `.github/workflows/pr-mobile.yml` se ejecuta en cada pull request y push a `main`. Instala las dependencias con Node.js 20 y valida el proyecto mediante Expo Doctor. Antes de subir cambios se puede correr la misma validación localmente:

```powershell
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
