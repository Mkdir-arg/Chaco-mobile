import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { becasRequest, becasUploadFile, getBecasToken, getStoredBecasUser } from './becasApi';
import { validateAttachmentMetadata } from './formularioSync';
import { openSqliteSerialized, serializeSqliteAccess } from './sqliteAccess';
import { persistWebAttachment } from './webAttachments';

// Módulo Relevamiento de Dispositivos: caché de inspecciones y cola de envíos offline.
// Va aparte del de Becas: base, carpeta de archivos y rutas propias.
const MODULO = 'dispositivos';
const INSPECCIONES_PATH = '/api/dispositivos/inspecciones/';
const SQLITE_DB_NAME = 'dispositivos_offline.db';
const SQLITE_LISTADO_TABLE = 'cache_inspecciones_listado';
const SQLITE_DETALLE_TABLE = 'cache_inspecciones_detalle';
const SQLITE_OUTBOX_TABLE = 'outbox_dispositivos';
const ATTACHMENTS_DIR = `${FileSystem.documentDirectory}attachments/dispositivos`;
const MAX_RETRY_COUNT = 8;
// Si el proceso muere durante un envío no queda promesa viva: se recupera pronto.
// Todo paso confirmado queda marcado y el back es idempotente por uuid_cliente.
const OUTBOX_IN_FLIGHT_TIMEOUT_MS = 30 * 1000;
const BACKGROUND_SYNC_WAIT_MS = 1500;
const PAUSED_RETRY_MS = 5 * 60 * 1000;
const CRITICIDADES = ['BAJA', 'MEDIA', 'ALTA'];
const CODES_DESCARTE_409 = ['YA_REALIZADA', 'CANCELADA', 'REASIGNADA', 'ESTADO_NO_ADMITE'];
const ERROR_ARCHIVO_LOCAL_FALTANTE = 'ARCHIVO_LOCAL_FALTANTE';

let syncInFlightPromise = null;
let sqliteDbPromise = null;
let sqliteInitPromise = null;
const sinModuloListeners = new Set();

// El listener recibe el nombre del módulo que el back dejó de admitir y el token con el que
// se hizo el pedido rechazado.
export const subscribeSinModulo = (listener) => {
  sinModuloListeners.add(listener);
  return () => sinModuloListeners.delete(listener);
};
const notificarSinModulo = (error) => sinModuloListeners.forEach((listener) => {
  try {
    listener(MODULO, error?.requestToken ?? null);
  } catch (error) {
    console.warn('[DISPOSITIVOS][SIN_MODULO][LISTENER]', error?.message);
  }
});

const nowIso = () => new Date().toISOString();
const createUuid = () => String(Crypto.randomUUID()).toLowerCase();
const safeParse = (value, fallback = null) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const rutaInspeccion = (id, sufijo = '') => `${INSPECCIONES_PATH}${encodeURIComponent(id)}/${sufijo}`;
const getCurrentOwnerId = async () => {
  const user = await getStoredBecasUser();
  return user?.id == null ? '' : String(user.id);
};
const calculateBackoffMs = (retryCount = 0) => Math.min(5 * 60 * 1000, 2500 * (2 ** Math.max(0, retryCount)));
const createError = (code, message) => Object.assign(new Error(message), { code });

const getSqliteDb = async () => {
  if (!sqliteDbPromise) {
    sqliteDbPromise = openSqliteSerialized(SQLite.openDatabaseAsync, SQLITE_DB_NAME).then(serializeSqliteAccess);
  }
  return sqliteDbPromise;
};

const runSqliteTx = async (db, task) => {
  if (typeof db.withExclusiveTransactionAsync === 'function') {
    try {
      await db.withExclusiveTransactionAsync(task);
      return;
    } catch (error) {
      if (!String(error?.message || '').includes('not supported on web')) throw error;
    }
  }
  await db.withTransactionAsync(task);
};

const recoverStaleInFlightOperations = async (db) => {
  const threshold = new Date(Date.now() - OUTBOX_IN_FLIGHT_TIMEOUT_MS).toISOString();
  await db.runAsync(
    `UPDATE ${SQLITE_OUTBOX_TABLE}
     SET status = 'PENDING', started_at = NULL, updated_at = ?
     WHERE status = 'IN_FLIGHT' AND (started_at IS NULL OR started_at <= ?)`,
    nowIso(),
    threshold
  );
};

const ensureSqliteReady = async () => {
  if (!sqliteInitPromise) {
    sqliteInitPromise = (async () => {
      const db = await getSqliteDb();
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS ${SQLITE_LISTADO_TABLE} (
          owner_user_id TEXT NOT NULL,
          inspeccion_id TEXT NOT NULL,
          orden INTEGER NOT NULL,
          formulario_version INTEGER,
          data_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (owner_user_id, inspeccion_id)
        );
        CREATE TABLE IF NOT EXISTS ${SQLITE_DETALLE_TABLE} (
          owner_user_id TEXT NOT NULL,
          inspeccion_id TEXT NOT NULL,
          formulario_version INTEGER,
          data_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (owner_user_id, inspeccion_id)
        );
        CREATE TABLE IF NOT EXISTS ${SQLITE_OUTBOX_TABLE} (
          op_id TEXT PRIMARY KEY NOT NULL,
          owner_user_id TEXT NOT NULL,
          inspeccion_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING',
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          ack_at TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at TEXT,
          last_error TEXT,
          last_error_code TEXT,
          last_error_json TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_${SQLITE_OUTBOX_TABLE}_owner_status
        ON ${SQLITE_OUTBOX_TABLE} (owner_user_id, status, created_at);
      `);
      await recoverStaleInFlightOperations(db);
    })();
  }
  await sqliteInitPromise;
};

const withDb = async () => {
  await ensureSqliteReady();
  return getSqliteDb();
};

const getConnectivitySnapshot = async () => {
  try {
    const state = await NetInfo.fetch();
    return !!state?.isConnected && state?.isInternetReachable !== false;
  } catch {
    return false;
  }
};

// ---- Archivos locales ----

const sanitizeFileName = (value = 'archivo') =>
  String(value).replace(/[^\w.-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'archivo';

const inferMimeType = (name = '') => {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
};

const isPersistentUri = (uri = '') => String(uri).startsWith(ATTACHMENTS_DIR);

const persistLocalFileIfNeeded = async ({ uri, fileName, mimeType, size }) => {
  if (!uri) throw createError(ERROR_ARCHIVO_LOCAL_FALTANTE, 'Falta el archivo a adjuntar.');
  if (isPersistentUri(uri)) return { uri, mimeType, size };
  if (Platform.OS === 'web') {
    return persistWebAttachment({ uri, mimeType: mimeType || inferMimeType(fileName), size });
  }
  const dir = await FileSystem.getInfoAsync(ATTACHMENTS_DIR);
  if (!dir.exists) await FileSystem.makeDirectoryAsync(ATTACHMENTS_DIR, { intermediates: true });
  const source = await FileSystem.getInfoAsync(uri, { size: true });
  if (!String(uri).startsWith('content://') && !source.exists) {
    throw createError(ERROR_ARCHIVO_LOCAL_FALTANTE, 'Adjunto no disponible, volvé a adjuntarlo');
  }
  const baseName = sanitizeFileName(fileName || String(uri).split('/').pop());
  const stableUri = `${ATTACHMENTS_DIR}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${baseName}`;
  await FileSystem.copyAsync({ from: uri, to: stableUri });
  const stable = await FileSystem.getInfoAsync(stableUri, { size: true });
  return { uri: stableUri, mimeType: mimeType || inferMimeType(baseName), size: stable?.size || size || null };
};

const prepararArchivo = async (item = {}, extra = {}) => {
  const fileName = sanitizeFileName(item.fileName || String(item.uri || '').split('/').pop());
  validateAttachmentMetadata({ fileName, uri: item.uri, size: item.size });
  const persisted = await persistLocalFileIfNeeded({ ...item, fileName });
  return {
    ...extra,
    uuid_cliente: createUuid(),
    uri: persisted.uri,
    fileName,
    mimeType: persisted.mimeType || item.mimeType || inferMimeType(fileName),
    size: persisted.size ?? item.size ?? null,
  };
};

const borrarArchivosLocales = async (payload = {}) => {
  if (Platform.OS === 'web' || typeof FileSystem.deleteAsync !== 'function') return;
  for (const item of [...(payload.archivos || []), ...(payload.fotos || [])]) {
    try {
      if (isPersistentUri(item.uri)) await FileSystem.deleteAsync(item.uri, { idempotent: true });
    } catch {
      // Un archivo que no se pudo borrar no invalida el envío ya confirmado.
    }
  }
};

// ---- Caché ----

const leerListadoCache = async (ownerId) => {
  const db = await withDb();
  const rows = await db.getAllAsync(
    `SELECT data_json FROM ${SQLITE_LISTADO_TABLE} WHERE owner_user_id = ? ORDER BY orden ASC`, ownerId);
  return rows.map((row) => safeParse(row.data_json, null)).filter(Boolean);
};

const leerDetalleCache = async (ownerId, id) => {
  const db = await withDb();
  const row = await db.getFirstAsync(
    `SELECT data_json FROM ${SQLITE_DETALLE_TABLE} WHERE owner_user_id = ? AND inspeccion_id = ?`, ownerId, String(id));
  return row ? safeParse(row.data_json, null) : null;
};

const versionDe = (inspeccion) => {
  const version = inspeccion?.formulario_version ?? inspeccion?.formulario?.version ?? null;
  return version == null ? null : Number(version);
};

const guardarListadoCache = async (ownerId, items) => {
  const db = await withDb();
  const stamp = nowIso();
  await runSqliteTx(db, async (tx) => {
    await tx.runAsync(`DELETE FROM ${SQLITE_LISTADO_TABLE} WHERE owner_user_id = ?`, ownerId);
    let orden = 0;
    for (const item of items) {
      await tx.runAsync(
        `INSERT OR REPLACE INTO ${SQLITE_LISTADO_TABLE}
         (owner_user_id, inspeccion_id, orden, formulario_version, data_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ownerId, String(item.id), orden, versionDe(item),
        JSON.stringify({ ...item, _owner_user_id: ownerId }), stamp);
      orden += 1;
    }
    // El detalle de lo que salió del listado se poda, salvo que tenga envíos en la cola.
    await tx.runAsync(
      `DELETE FROM ${SQLITE_DETALLE_TABLE}
       WHERE owner_user_id = ?
         AND inspeccion_id NOT IN (SELECT inspeccion_id FROM ${SQLITE_LISTADO_TABLE} WHERE owner_user_id = ?)
         AND inspeccion_id NOT IN (SELECT inspeccion_id FROM ${SQLITE_OUTBOX_TABLE} WHERE owner_user_id = ?)`,
      ownerId, ownerId, ownerId);
  });
};

const guardarDetalleCache = async (ownerId, detalle) => {
  if (!ownerId || !detalle?.id) return;
  const db = await withDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO ${SQLITE_DETALLE_TABLE}
     (owner_user_id, inspeccion_id, formulario_version, data_json, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ownerId, String(detalle.id), versionDe(detalle),
    JSON.stringify({ ...detalle, _owner_user_id: ownerId }), nowIso());
};

// ---- Estado local de envío ----

const mapOutboxRow = (row = {}) => ({
  op_id: row.op_id,
  owner_user_id: row.owner_user_id,
  inspeccion_id: row.inspeccion_id,
  status: row.status || 'PENDING',
  payload: safeParse(row.payload_json, {}),
  created_at: row.created_at,
  started_at: row.started_at || null,
  ack_at: row.ack_at || null,
  retry_count: Number(row.retry_count || 0),
  next_retry_at: row.next_retry_at || null,
  last_error: row.last_error || null,
  last_error_code: row.last_error_code || null,
  last_error_info: safeParse(row.last_error_json, null),
});

const ESTADO_ENVIO = {
  PENDING: 'pendiente',
  IN_FLIGHT: 'en_cola',
  FAILED_PERMANENT: 'error',
  DISCARDED: 'error',
  DONE: 'enviado',
};

// pendiente = esperando envío (o reintento); en_cola = enviándose ahora; error = no se
// va a reintentar sola (ver `permanente`); enviado = el back lo confirmó.
const mapEnvio = (op) => op && ({
  op_id: op.op_id,
  estado: ESTADO_ENVIO[op.status] || 'pendiente',
  status: op.status,
  permanente: op.status === 'FAILED_PERMANENT' || op.status === 'DISCARDED',
  descartada: op.status === 'DISCARDED',
  code: op.last_error_code,
  detail: op.last_error_info?.detail ?? op.last_error,
  claves: op.last_error_info?.claves ?? null,
  retry_count: op.retry_count,
  next_retry_at: op.next_retry_at,
  created_at: op.created_at,
});

const readOperations = async (ownerId, where = '1 = 1', ...args) => {
  const db = await withDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM ${SQLITE_OUTBOX_TABLE} WHERE owner_user_id = ? AND ${where} ORDER BY created_at ASC, rowid ASC`,
    ownerId, ...args);
  return rows.map(mapOutboxRow);
};

const enviosPorInspeccion = async (ownerId) => {
  const porId = new Map();
  for (const op of await readOperations(ownerId)) porId.set(String(op.inspeccion_id), mapEnvio(op));
  return porId;
};

const conEnvio = (inspeccion, envios) => ({ ...inspeccion, envio: envios.get(String(inspeccion.id)) || null });

// ---- Lectura ----

const esFallaTransitoria = (error) => {
  const status = Number(error?.status || 0);
  return error?.network === true || error?.unexpectedHtml === true || !status
    || status >= 500 || status === 408 || status === 429
    || (status === 403 && !error?.payload?.code);
};

const esSinModulo = (error) => Number(error?.status) === 403 && error?.payload?.code === 'SIN_MODULO'
  && !error?.unexpectedHtml;

const traerDetalle = async (ownerId, id) => {
  const detalle = await becasRequest(rutaInspeccion(id));
  await guardarDetalleCache(ownerId, detalle);
  return detalle;
};

export const getInspecciones = async ({ refreshFromRemote = true } = {}) => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return [];
  const envios = await enviosPorInspeccion(ownerId);
  if (refreshFromRemote && await getConnectivitySnapshot()) {
    try {
      const remoto = await becasRequest(INSPECCIONES_PATH);
      const items = Array.isArray(remoto) ? remoto : (remoto?.results || []);
      await guardarListadoCache(ownerId, items);
      // Deja el detalle listo para trabajar sin red: solo los que cambiaron de versión.
      for (const item of items) {
        const cached = await leerDetalleCache(ownerId, item.id);
        if (cached && versionDe(cached) === versionDe(item)) continue;
        try {
          await traerDetalle(ownerId, item.id);
        } catch (error) {
          if (!esFallaTransitoria(error)) continue;
          break;
        }
      }
    } catch (error) {
      if (esSinModulo(error)) notificarSinModulo(error);
      if (!esFallaTransitoria(error) && !esSinModulo(error)) throw error;
    }
  }
  return (await leerListadoCache(ownerId)).map((item) => conEnvio(item, envios));
};

export const getInspeccion = async (id, { refreshFromRemote = true } = {}) => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId || id == null) return null;
  const envios = await enviosPorInspeccion(ownerId);
  const cached = await leerDetalleCache(ownerId, id);
  const listado = (await leerListadoCache(ownerId)).find((item) => String(item.id) === String(id));
  const versionCambio = !!listado && !!cached && versionDe(listado) !== versionDe(cached);
  if ((refreshFromRemote || !cached || versionCambio) && await getConnectivitySnapshot()) {
    try {
      return conEnvio(await traerDetalle(ownerId, id), envios);
    } catch (error) {
      if (esSinModulo(error)) notificarSinModulo(error);
      if (!cached || !(esFallaTransitoria(error) || esSinModulo(error))) throw error;
    }
  }
  return cached ? conEnvio(cached, envios) : null;
};

export const getEstadoEnvio = async (inspeccionId) => {
  const ownerId = await getCurrentOwnerId();
  return ownerId ? (await enviosPorInspeccion(ownerId)).get(String(inspeccionId)) || null : null;
};

export const getEnvios = async () => {
  const ownerId = await getCurrentOwnerId();
  return ownerId ? [...(await enviosPorInspeccion(ownerId)).values()] : [];
};

// Lo que todavía guarda datos del usuario sin entregar: el aviso de logout y el badge.
export const getPendingCount = async () => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return 0;
  const db = await withDb();
  const row = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM ${SQLITE_OUTBOX_TABLE}
     WHERE owner_user_id = ? AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')`, ownerId);
  return Number(row?.count || 0);
};

// ---- Encolar ----

export const enviarResultado = async (inspeccionId, {
  criticidad, observaciones = '', respuestas, archivos = {}, fotos = [], versionCapturada,
} = {}, { sincronizar = true } = {}) => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) throw new Error('No hay sesión iniciada.');
  if (!CRITICIDADES.includes(criticidad)) throw createError('CRITICIDAD_INVALIDA', 'Elegí la criticidad: BAJA, MEDIA o ALTA.');
  const previas = (await readOperations(ownerId, 'inspeccion_id = ?', String(inspeccionId)));
  if (previas.some((op) => ['PENDING', 'IN_FLIGHT'].includes(op.status))) {
    throw createError('YA_EN_COLA', 'Este relevamiento ya tiene un envío en curso.');
  }
  if (previas.some((op) => op.status === 'DONE')) {
    throw createError('YA_ENVIADO', 'Este relevamiento ya se envió.');
  }

  const detalle = await leerDetalleCache(ownerId, inspeccionId);
  const sinFormulario = !!detalle && !detalle.formulario;
  const version = versionCapturada ?? (detalle ? versionDe(detalle) : null);

  const adjuntos = [];
  let respuestasEnviar = sinFormulario || !respuestas ? null : { ...respuestas };
  if (!sinFormulario) {
    for (const [clave, archivo] of Object.entries(archivos || {})) {
      if (!archivo?.uri) continue;
      const item = await prepararArchivo(archivo, { id: `a${adjuntos.length}`, clave });
      adjuntos.push(item);
      // Igual que Becas: el archivo viaja aparte y en la respuesta va el marcador.
      respuestasEnviar = { ...respuestasEnviar, [clave]: { archivo_adjunto: true, nombre: item.fileName } };
    }
  }
  const fotosFinal = [];
  for (const foto of fotos || []) {
    if (!foto?.uri) continue;
    fotosFinal.push(await prepararArchivo(foto, { id: `f${fotosFinal.length}`, descripcion: foto.descripcion || '' }));
  }

  const stamp = nowIso();
  const opId = `disp_${createUuid()}`;
  const payload = {
    _owner_user_id: ownerId,
    modulo: MODULO,
    inspeccion_id: inspeccionId,
    uuid_cliente: createUuid(),
    criticidad,
    observaciones: observaciones || '',
    version_capturada: version,
    respuestas: respuestasEnviar,
    archivos: adjuntos,
    fotos: fotosFinal,
    hecho: { resultado: false, archivos: [], fotos: [] },
    capturado_en: stamp,
  };
  const db = await withDb();
  await runSqliteTx(db, async (tx) => {
    // Un envío nuevo reemplaza al que había quedado en error: no debe reintentarse el viejo.
    await tx.runAsync(
      `UPDATE ${SQLITE_OUTBOX_TABLE} SET status = 'DISCARDED', updated_at = ?
       WHERE owner_user_id = ? AND inspeccion_id = ? AND status = 'FAILED_PERMANENT'`,
      stamp, ownerId, String(inspeccionId));
    await tx.runAsync(
      `INSERT INTO ${SQLITE_OUTBOX_TABLE}
       (op_id, owner_user_id, inspeccion_id, status, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`,
      opId, ownerId, String(inspeccionId), JSON.stringify(payload), stamp, stamp);
  });

  let syncResult = null;
  if (sincronizar) {
    let timer;
    syncResult = await Promise.race([
      syncPendientes().catch((error) => ({ synced: 0, failed: 0, errors: [{ message: error?.message }] })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ synced: 0, failed: 0, background: true }), BACKGROUND_SYNC_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  const [operacion] = await readOperations(ownerId, 'op_id = ?', opId);
  return { success: true, op_id: opId, envio: mapEnvio(operacion), syncResult };
};

// ---- Sync ----

const actualizarPayload = async (opId, payload) => {
  const db = await withDb();
  const stamp = nowIso();
  // También renueva started_at: mientras avanza no es una IN_FLIGHT abandonada.
  await db.runAsync(
    `UPDATE ${SQLITE_OUTBOX_TABLE} SET payload_json = ?, started_at = ?, updated_at = ? WHERE op_id = ?`,
    JSON.stringify(payload), stamp, stamp, opId);
};

const marcarEnVuelo = async (opId) => {
  const db = await withDb();
  const stamp = nowIso();
  const result = await db.runAsync(
    `UPDATE ${SQLITE_OUTBOX_TABLE} SET status = 'IN_FLIGHT', started_at = ?, updated_at = ?
     WHERE op_id = ? AND status = 'PENDING'`, stamp, stamp, opId);
  return Number(result?.changes || 0) > 0;
};

const cerrarOperacion = async (opId, { status, retryCount = 0, nextRetryAt = null, info = null }) => {
  const db = await withDb();
  const stamp = nowIso();
  await db.runAsync(
    `UPDATE ${SQLITE_OUTBOX_TABLE}
     SET status = ?, started_at = NULL, ack_at = ?, retry_count = ?, next_retry_at = ?,
         last_error = ?, last_error_code = ?, last_error_json = ?, updated_at = ?
     WHERE op_id = ?`,
    status, status === 'DONE' ? stamp : null, retryCount, nextRetryAt,
    status === 'DONE' ? null : info?.message ?? null, status === 'DONE' ? null : info?.code ?? null,
    status === 'DONE' || !info ? null : JSON.stringify(info), stamp, opId);
};

const subirItem = async (inspeccionId, tipo, item) => {
  if (Platform.OS !== 'web' && !String(item.uri).startsWith('content://')) {
    const info = await FileSystem.getInfoAsync(item.uri, { size: true });
    if (!info.exists) throw createError(ERROR_ARCHIVO_LOCAL_FALTANTE, 'Adjunto no disponible, volvé a adjuntarlo');
  }
  const fields = tipo === 'adjuntos'
    ? { clave: item.clave, uuid_cliente: item.uuid_cliente }
    : { uuid_cliente: item.uuid_cliente, descripcion: item.descripcion || null };
  return becasUploadFile(rutaInspeccion(inspeccionId, `${tipo}/`), {
    fileUri: item.uri, fileName: item.fileName, mimeType: item.mimeType, fields,
  });
};

// Envía lo que falta de la operación, en orden: resultado, adjuntos y fotos. Cada paso
// confirmado se guarda en `hecho` para que un reintento no lo repita.
const ejecutarOperacion = async (operation, ownerId) => {
  let payload = operation.payload;
  const id = payload.inspeccion_id;
  const guardar = async (cambios) => {
    payload = { ...payload, ...cambios };
    await actualizarPayload(operation.op_id, payload);
  };

  if (!payload.hecho?.resultado) {
    const body = {
      criticidad: payload.criticidad,
      observaciones: payload.observaciones || '',
      uuid_cliente: payload.uuid_cliente,
      ...(payload.version_capturada != null ? { version_capturada: payload.version_capturada } : {}),
      ...(payload.respuestas ? { respuestas: payload.respuestas } : {}),
    };
    const detalle = await becasRequest(rutaInspeccion(id, 'resultado/'), { method: 'POST', body });
    await guardar({ hecho: { ...payload.hecho, resultado: true } });
    try {
      await guardarDetalleCache(ownerId, detalle);
    } catch (error) {
      console.warn('[DISPOSITIVOS][CACHE]', error?.message);
    }
  }

  for (const [tipo, campo] of [['adjuntos', 'archivos'], ['fotos', 'fotos']]) {
    for (const original of payload[campo] || []) {
      if ((payload.hecho[campo] || []).includes(original.id)) continue;
      let item = original;
      try {
        await subirItem(id, tipo, item);
      } catch (error) {
        const regenerable = Number(error?.status) === 409 && error?.payload?.code === 'UUID_EN_USO'
          && !item.uuid_regenerado;
        if (!regenerable) throw error;
        // El identificador ya lo usa otro: se cambia una sola vez; si vuelve, es permanente.
        item = { ...item, uuid_cliente: createUuid(), uuid_regenerado: true };
        await guardar({ [campo]: payload[campo].map((it) => (it.id === item.id ? item : it)) });
        await subirItem(id, tipo, item);
      }
      await guardar({ hecho: { ...payload.hecho, [campo]: [...(payload.hecho[campo] || []), item.id] } });
    }
  }
  return payload;
};

// Solo por status y `payload.code`; nunca por el texto del mensaje.
const clasificarError = (error) => {
  const status = Number(error?.status || 0);
  const payload = error?.payload && typeof error.payload === 'object' ? error.payload : null;
  const code = payload?.code || null;
  const info = { status, code: code || error?.code || null, message: error?.message || 'Error desconocido',
    detail: payload?.detail ?? null, claves: payload?.claves ?? null };
  if (error?.code === ERROR_ARCHIVO_LOCAL_FALTANTE) return { accion: 'permanente', info };
  if (status === 401) return { accion: 'sesion', info: { ...info, code: 'AUTH_REQUIRED' } };
  if (error?.unexpectedHtml === true) return { accion: 'reintento', info };
  if (status === 403 && code === 'SIN_MODULO') return { accion: 'sin_modulo', info };
  if (status === 429) {
    return { accion: 'espera', espera: error?.retryAfter ?? PAUSED_RETRY_MS, info: { ...info, code: code || 'RATE_LIMITED' } };
  }
  if (status === 404) return { accion: 'descartar', info: { ...info, code: 'NO_ENCONTRADA' } };
  if (status === 409) {
    if (CODES_DESCARTE_409.includes(code)) return { accion: 'descartar', info };
    return { accion: 'permanente', info: { ...info, code: code || 'CONFLICTO' } };
  }
  if (status === 400) return { accion: 'permanente', info: { ...info, code: 'DATOS_INVALIDOS' } };
  if (status === 403 || status >= 500 || status === 408 || !status) return { accion: 'reintento', info };
  return { accion: 'permanente', info: { ...info, code: code || 'RECHAZADA' } };
};

const aplicarFalla = async (operation, error) => {
  const { accion, info, espera } = clasificarError(error);
  const retryCount = operation.retry_count || 0;
  if (accion === 'sesion') {
    await cerrarOperacion(operation.op_id, { status: 'PENDING', retryCount, info });
  } else if (accion === 'sin_modulo') {
    await cerrarOperacion(operation.op_id, {
      status: 'PENDING', retryCount, info, nextRetryAt: new Date(Date.now() + PAUSED_RETRY_MS).toISOString(),
    });
    notificarSinModulo(error);
  } else if (accion === 'espera') {
    await cerrarOperacion(operation.op_id, {
      status: 'PENDING', retryCount, info, nextRetryAt: new Date(Date.now() + espera).toISOString(),
    });
  } else if (accion === 'reintento') {
    const proximo = retryCount + 1;
    if (proximo > MAX_RETRY_COUNT) {
      await cerrarOperacion(operation.op_id, {
        status: 'FAILED_PERMANENT', retryCount: proximo, info: { ...info, code: 'REINTENTOS_AGOTADOS' },
      });
    } else {
      await cerrarOperacion(operation.op_id, {
        status: 'PENDING', retryCount: proximo, info,
        nextRetryAt: new Date(Date.now() + calculateBackoffMs(proximo)).toISOString(),
      });
    }
  } else {
    await cerrarOperacion(operation.op_id, {
      status: accion === 'descartar' ? 'DISCARDED' : 'FAILED_PERMANENT', retryCount, info,
    });
  }
  return { accion, info };
};

export const syncPendientes = async () => {
  await ensureSqliteReady();
  if (syncInFlightPromise) return syncInFlightPromise;
  syncInFlightPromise = (async () => {
    const ownerId = await getCurrentOwnerId();
    if (!ownerId) return { synced: 0, failed: 0, errors: [] };
    const db = await getSqliteDb();
    await recoverStaleInFlightOperations(db);
    const queue = await readOperations(ownerId, "status = 'PENDING'");
    if (!queue.length) return { synced: 0, failed: 0, errors: [] };
    if (!await getConnectivitySnapshot()) {
      return { synced: 0, failed: 0, skipped: queue.length, offline: true, errors: [{ message: 'Sin conexion' }] };
    }

    let synced = 0;
    let failed = 0;
    const errors = [];
    const ahora = Date.now();
    for (const operation of queue) {
      // Otra petición pudo invalidar la sesión mientras sincronizábamos.
      if (!await getBecasToken()) break;
      const proximo = operation.next_retry_at ? Date.parse(operation.next_retry_at) : null;
      if (proximo && Number.isFinite(proximo) && proximo > ahora) continue;
      if (!await marcarEnVuelo(operation.op_id)) continue;
      try {
        const payload = await ejecutarOperacion(operation, ownerId);
        await cerrarOperacion(operation.op_id, { status: 'DONE' });
        await borrarArchivosLocales(payload);
        synced += 1;
      } catch (error) {
        failed += 1;
        const { accion, info } = await aplicarFalla(operation, error);
        errors.push({ op_id: operation.op_id, message: info.message, code: info.code });
        // Sesión o módulo: vale para todo lo que sigue en la cola, se corta la pasada.
        if (accion === 'sesion' || accion === 'sin_modulo') break;
      }
    }
    return { synced, failed, errors };
  })();
  try {
    return await syncInFlightPromise;
  } finally {
    syncInFlightPromise = null;
  }
};

// Las que quedaron en error vuelven a la cola con el contador a cero.
export const reintentarFallidas = async () => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return { synced: 0, failed: 0, errors: [] };
  if (syncInFlightPromise) await syncInFlightPromise;
  const db = await withDb();
  await db.runAsync(
    `UPDATE ${SQLITE_OUTBOX_TABLE}
     SET status = 'PENDING', retry_count = 0, next_retry_at = NULL, started_at = NULL, updated_at = ?
     WHERE owner_user_id = ? AND status = 'FAILED_PERMANENT'`, nowIso(), ownerId);
  return syncPendientes();
};

export default {
  subscribeSinModulo,
  getInspecciones,
  getInspeccion,
  getEstadoEnvio,
  getEnvios,
  getPendingCount,
  enviarResultado,
  syncPendientes,
  reintentarFallidas,
};
