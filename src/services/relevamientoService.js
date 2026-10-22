import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import { serializeSqliteAccess } from './sqliteAccess';
import { persistWebAttachment, readWebBlob } from './webAttachments';
import { usaConstructor, camposDelDiseno, cupoDisponibleConfiable } from './definicionFormulario';
import { Platform } from 'react-native';
import { becasRequest, becasUploadFile, getBecasToken, getStoredBecasUser } from './becasApi';
import { ahoraCorregido } from './reloj';
import { isDateTimeActive } from '../utils/dates';
import { GRACE_EXPIRED, INVALID_SUBMISSION, REJECTED_ATTACHMENTS, isGraceExpired, validateAttachmentMetadata } from './formularioSync';

const LOCAL_RELEVAMIENTOS_KEY = 'field_relevamientos_records';
const SYNC_QUEUE_KEY = 'field_relevamientos_sync_queue';
const SQLITE_DB_NAME = 'relevamientos_offline.db';
const SQLITE_LOCAL_TABLE = 'local_relevamientos';
const SQLITE_OUTBOX_TABLE = 'outbox_relevamientos';
const SQLITE_META_TABLE = 'sync_metadata';
const SQLITE_MIGRATION_FLAG_KEY = 'field_relevamientos_sqlite_migrated_v1';
const ATTACHMENTS_DIR = `${FileSystem.documentDirectory}attachments`;
const MAX_RETRY_COUNT = 8;
// Si la app se recarga, se cierra o Android mata el proceso durante un envio,
// no queda ninguna promesa viva que pueda completar la operacion. Recuperarla
// pronto; el client_uuid del formulario mantiene el reintento idempotente.
const OUTBOX_IN_FLIGHT_TIMEOUT_MS = 30 * 1000;
const BACKGROUND_SYNC_WAIT_MS = 1500;
const ERROR_MISSING_LOCAL_FILE = 'ERROR_MISSING_LOCAL_FILE';
const ERROR_ATTACHMENTS_UPLOAD = 'ERROR_ATTACHMENTS_UPLOAD';
const ERROR_REMOTE_SCHEMA = 'ERROR_REMOTE_SCHEMA';
const ERROR_RELEVAMIENTO_PAUSADO = 'RELEVAMIENTO_PAUSADO';
const ERROR_SIN_ACCESO = 'SIN_ACCESO';
const ERROR_CLIENT_UUID_EN_USO = 'CLIENT_UUID_EN_USO';
const ERROR_RELEVAMIENTO_NO_DISPONIBLE = 'RELEVAMIENTO_NO_DISPONIBLE';
const PAUSED_RETRY_MS = 5 * 60 * 1000;
// El alta entra hasta `fecha_hasta` + 24 h. Mientras dure, una carga que no pudo
// enviarse por falla del servidor o de la red no pasa a FAILED_PERMANENT.
const GRACE_MS = 24 * 60 * 60 * 1000;
const UUID_REGENERADO_FLAG_KEY = 'client_uuid_baja_entropia_regenerado_v1';
const ESTADOS_RELEVAMIENTO = ['ASIGNADO', 'EN_CURSO', 'FINALIZANDO', 'FINALIZADO', 'EN_REVISION', 'TERMINADO'];

let syncInFlightPromise = null;
let sqliteDbPromise = null;
let sqliteInitPromise = null;

const nowIso = () => new Date().toISOString();
const createLocalId = () => `local_rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const createRemoteCacheId = (backend, id) => `remote_${String(backend || 'api')}_${String(id)}`;
// Hora corregida con el header `Date` del servidor: el reloj del teléfono puede estar corrido.
const nowCorrectedIso = () => ahoraCorregido().toISOString();
// UUID criptográfico (expo-crypto; en web usa window.crypto). El Math.random queda solo
// como último respaldo: con él dos cargas distintas podrían chocar en el servidor.
const createClientUuid = () => {
  for (const randomUUID of [() => Crypto.randomUUID?.(), () => globalThis.crypto?.randomUUID?.()]) {
    try {
      const uuid = randomUUID();
      if (uuid) return uuid;
    } catch {
      // Se prueba el siguiente generador.
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
};
const deriveClientUuidFromSeed = (seed = '') => {
  const base = String(seed || createLocalId());
  let hex = '';
  for (let i = 0; i < base.length; i += 1) {
    hex += (base.charCodeAt(i) % 16).toString(16);
  }
  const padded = (hex + '0123456789abcdef0123456789abcdef').slice(0, 32);
  return `${padded.slice(0, 8)}-${padded.slice(8, 12)}-4${padded.slice(13, 16)}-a${padded.slice(17, 20)}-${padded.slice(20, 32)}`;
};

const safeParse = (value, fallback = []) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const uniqueBy = (items = [], keySelector) => {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keySelector(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};
const toSqliteBool = (value) => (value ? 1 : 0);
const normalizeUuid = (value) => String(value || '').trim().toLowerCase();
const getCurrentOwnerId = async () => {
  const user = await getStoredBecasUser();
  return user?.id == null ? '' : String(user.id);
};
const belongsToOwner = (record, ownerId) => (
  Boolean(ownerId)
  && String(record?.payload?._owner_user_id || '') === ownerId
);

const mapDjangoRelevamiento = (row = {}) => ({
  id: row.id,
  source: 'asignado',
  backend: 'django_becas',
  titulo: row.nombre || 'Relevamiento',
  descripcion: row.convocatoria_nombre || '',
  direccion_objetivo: row.zona || '',
  localidad: row.zona || '',
  provincia: 'Chaco',
  prioridad: 'MEDIA',
  estado: row.estado,
  fecha_asignada: row.fecha_asignada || null,
  fecha_hasta: row.fecha_hasta || row.fecha_asignada || null,
  id_institucion: null,
  created_at: row.fecha_asignada || row.fecha_finalizado || nowIso(),
  relevado_at: row.fecha_finalizado || null,
  last_synced_at: row.fecha_finalizado || null,
  sync_estado: row.estado === 'FINALIZADO' ? 'SINCRONIZADO' : 'PENDIENTE',
  observaciones: row.convocatoria_nombre || row.segmento || '',
  latitud: null,
  longitud: null,
  segmento: row.segmento || '',
  localidad: row.localidad || '',
  convocatoria_nombre: row.convocatoria_nombre || '',
  formularios_count: row.formularios_count || 0,
  personas_count: row.formularios_count || 0,
  cupo_maximo: Number(row.cupo_maximo || 0),
  // null = el servidor no lo informó (back viejo): la pantalla cae al cálculo local.
  cupo_disponible: row.cupo_disponible == null ? null : Number(row.cupo_disponible),
  cupo_completo: row.cupo_completo == null ? null : Boolean(row.cupo_completo),
  pausado: Boolean(row.pausado),
  pausa_motivo: row.pausa_motivo || '',
});

const normalizeDjangoField = (field = {}, scope = 'globales') => ({
  id: `${scope}:${field.id}`,
  original_id: field.id,
  scope,
  nombre: field.texto || 'Campo',
  etiqueta: field.texto || 'Campo',
  texto: field.texto || 'Campo',
  tipo: field.tipo,
  opciones: field.opciones || [],
  requerido: !!field.obligatorio,
  obligatorio: !!field.obligatorio,
  orden: field.orden || 0,
  alcance: field.alcance || null,
  subsegmento_id: field.subsegmento_id ?? null,
});

const mapDjangoRelevamientoDetail = (row = {}) => {
  const base = mapDjangoRelevamiento(row);
  const definicion = row.definicion_formulario || {};
  const globales = (definicion.globales || []).map((field) => normalizeDjangoField(field, 'globales'));
  const requisitos = (definicion.requisitos || []).map((field) => normalizeDjangoField(field, 'requisitos'));
  return {
    ...base,
    ...row,
    source: 'asignado',
    backend: 'django_becas',
    titulo: row.nombre || 'Relevamiento',
    campos_definicion: usaConstructor(definicion) ? camposDelDiseno(definicion)
      : [...globales, ...requisitos].sort((a, b) => (a.orden || 0) - (b.orden || 0)),
    definicion_formulario: {
      ...definicion,
      requiere_gps: !!definicion.requiere_gps,
      globales,
      requisitos,
    },
    campos_extra: [],
    adjuntos: [],
    payload: {},
  };
};

const getSqliteDb = async () => {
  if (!sqliteDbPromise) {
    sqliteDbPromise = SQLite.openDatabaseAsync(SQLITE_DB_NAME).then(serializeSqliteAccess);
  }
  return sqliteDbPromise;
};

const runSqliteTx = async (db, task) => {
  if (typeof db.withExclusiveTransactionAsync === 'function') {
    try {
      await db.withExclusiveTransactionAsync(task);
      return;
    } catch (error) {
      if (!String(error?.message || '').includes('not supported on web')) {
        throw error;
      }
    }
  }
  await db.withTransactionAsync(task);
};

const ensureSqliteColumn = async (db, tableName, columnName, columnDef) => {
  const rows = await db.getAllAsync(`PRAGMA table_info(${tableName})`);
  const exists = rows.some((row) => row?.name === columnName);
  if (!exists) {
    await db.execAsync(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef};`);
  }
};

const getMetaValue = async (db, key) => {
  const row = await db.getFirstAsync(
    `SELECT value FROM ${SQLITE_META_TABLE} WHERE key = ?`,
    key
  );
  return row?.value ?? null;
};

const setMetaValue = async (db, key, value) => {
  await db.runAsync(
    `INSERT INTO ${SQLITE_META_TABLE} (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    String(value),
    nowIso()
  );
};

const recoverStaleInFlightOperations = async (db) => {
  const threshold = new Date(Date.now() - OUTBOX_IN_FLIGHT_TIMEOUT_MS).toISOString();
  await db.runAsync(
    `UPDATE ${SQLITE_OUTBOX_TABLE}
     SET status = 'PENDING',
         started_at = NULL,
         updated_at = ?,
         last_error = COALESCE(last_error, 'Recovered IN_FLIGHT after app restart')
     WHERE status = 'IN_FLIGHT'
       AND (started_at IS NULL OR started_at <= ?)`,
    nowIso(),
    threshold
  );
};

const mapLocalRow = (row = {}) => {
  const payload = safeParse(row.payload_json, {});
  const clientUuid = normalizeUuid(row.client_uuid || payload?.client_uuid || payload?.client_uid || '');
  if (clientUuid) {
    payload.client_uuid = clientUuid;
    payload.client_uid = clientUuid;
  }
  return {
    local_id: row.local_id,
    remote_id: row.remote_id || null,
    client_uuid: clientUuid || null,
    observaciones: row.observaciones || '',
    latitud: row.latitud ?? '',
    longitud: row.longitud ?? '',
    sync_estado: row.sync_estado || 'PENDIENTE',
    synced: !!row.synced,
    created_at: row.created_at || nowIso(),
    sync_error: row.sync_error || null,
    sync_error_code: row.sync_error_code || null,
    payload,
  };
};

const mapOutboxRow = (row = {}) => ({
  op_id: row.op_id,
  local_id: row.local_id,
  status: row.status || 'PENDING',
  type: row.type || 'insert_relevamiento',
  payload: safeParse(row.payload_json, {}),
  created_at: row.created_at || nowIso(),
  started_at: row.started_at || null,
  ack_at: row.ack_at || null,
  server_id: row.server_id || null,
  retry_count: Number(row.retry_count || 0),
  next_retry_at: row.next_retry_at || null,
  last_error: row.last_error || null,
  last_error_code: row.last_error_code || null,
  updated_at: row.updated_at || null,
});

const migrateAsyncStorageToSqliteIfNeeded = async (db) => {
  const [legacyFlag, sqliteMetaFlag] = await Promise.all([
    AsyncStorage.getItem(SQLITE_MIGRATION_FLAG_KEY),
    getMetaValue(db, 'migrated_to_sqlite_v1'),
  ]);
  if (legacyFlag === '1' && sqliteMetaFlag === '1') return;

  const localCountRow = await db.getFirstAsync(`SELECT COUNT(*) as count FROM ${SQLITE_LOCAL_TABLE}`);
  const localCount = Number(localCountRow?.count || 0);
  if (legacyFlag === '1' && localCount > 0) {
    await setMetaValue(db, 'migrated_to_sqlite_v1', '1');
    return;
  }

  const [legacyLocalRaw, legacyQueueRaw] = await Promise.all([
    AsyncStorage.getItem(LOCAL_RELEVAMIENTOS_KEY),
    AsyncStorage.getItem(SYNC_QUEUE_KEY),
  ]);
  const legacyLocal = safeParse(legacyLocalRaw, []);
  const legacyQueue = safeParse(legacyQueueRaw, []);
  if (!legacyLocal.length && !legacyQueue.length) {
    await Promise.all([
      AsyncStorage.setItem(SQLITE_MIGRATION_FLAG_KEY, '1'),
      setMetaValue(db, 'migrated_to_sqlite_v1', '1'),
    ]);
    return;
  }

  await runSqliteTx(db, async (tx) => {
    for (const item of legacyLocal) {
      const payload = item?.payload || {};
      const clientUuid = normalizeUuid(payload?.client_uuid || payload?.client_uid || deriveClientUuidFromSeed(item?.local_id));
      await tx.runAsync(
        `INSERT INTO ${SQLITE_LOCAL_TABLE}
        (local_id, remote_id, client_uuid, created_at, synced, sync_estado, sync_error, sync_error_code, observaciones, latitud, longitud, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_id) DO UPDATE SET
          remote_id = excluded.remote_id,
          client_uuid = excluded.client_uuid,
          created_at = excluded.created_at,
          synced = excluded.synced,
          sync_estado = excluded.sync_estado,
          sync_error = excluded.sync_error,
          sync_error_code = excluded.sync_error_code,
          observaciones = excluded.observaciones,
          latitud = excluded.latitud,
          longitud = excluded.longitud,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
        item?.local_id || createLocalId(),
        item?.remote_id || null,
        clientUuid || null,
        item?.created_at || nowIso(),
        toSqliteBool(!!item?.synced),
        item?.sync_estado || (item?.synced ? 'SINCRONIZADO' : 'PENDIENTE'),
        item?.sync_error || null,
        item?.sync_error_code || null,
        item?.observaciones || '',
        item?.latitud ?? '',
        item?.longitud ?? '',
        JSON.stringify(payload),
        nowIso()
      );
    }

    for (const op of legacyQueue) {
      const opClientUuid = normalizeUuid(op?.payload?.client_uuid || op?.payload?.client_uid || deriveClientUuidFromSeed(op?.local_id));
      await tx.runAsync(
        `INSERT INTO ${SQLITE_OUTBOX_TABLE}
        (local_id, op_id, type, payload_json, created_at, started_at, ack_at, server_id, retry_count, next_retry_at, last_error, last_error_code, status, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, 'PENDING', ?)
        ON CONFLICT(local_id) DO UPDATE SET
          op_id = excluded.op_id,
          type = excluded.type,
          payload_json = excluded.payload_json,
          created_at = excluded.created_at,
          retry_count = excluded.retry_count,
          next_retry_at = excluded.next_retry_at,
          last_error = excluded.last_error,
          last_error_code = excluded.last_error_code,
          status = 'PENDING',
          started_at = NULL,
          ack_at = NULL,
          updated_at = excluded.updated_at`,
        op?.local_id || createLocalId(),
        op?.op_id || createLocalId(),
        op?.type || 'insert_relevamiento',
        JSON.stringify({
          ...(op?.payload || {}),
          client_uuid: opClientUuid || null,
          client_uid: opClientUuid || null,
        }),
        op?.created_at || nowIso(),
        Number(op?.retry_count || 0),
        op?.next_retry_at || null,
        op?.last_error || null,
        op?.last_error_code || null,
        nowIso()
      );
    }

  });

  await Promise.all([
    AsyncStorage.setItem(SQLITE_MIGRATION_FLAG_KEY, '1'),
    setMetaValue(db, 'migrated_to_sqlite_v1', '1'),
  ]);
};

// Una sola vez: la migración AsyncStorage→SQLite derivaba el client_uuid del local_id
// (baja entropía: dos teléfonos podían generar el mismo). Si la carga nunca se intentó
// enviar se reemplaza por un uuid criptográfico. Si ya hubo un intento NO se toca: pudo
// haber llegado al servidor y de ese caso se ocupa CLIENT_UUID_EN_USO.
export const regenerarUuidsMigradosNuncaEnviados = async (db) => {
  if (await getMetaValue(db, UUID_REGENERADO_FLAG_KEY) === '1') return 0;
  const ops = await db.getAllAsync(
    `SELECT local_id, payload_json, retry_count, last_error FROM ${SQLITE_OUTBOX_TABLE}
     WHERE type = 'insert_relevamiento' AND status IN ('PENDING', 'FAILED_PERMANENT')`
  );
  const pendientes = [];
  for (const op of ops) {
    const payload = safeParse(op.payload_json, {});
    if (payload.remote_formulario_id) continue;
    if (Number(op.retry_count || 0) !== 0 || op.last_error) continue;
    const uuid = normalizeUuid(payload.client_uuid || payload.client_uid);
    if (!uuid || uuid !== normalizeUuid(deriveClientUuidFromSeed(op.local_id))) continue;
    const local = await db.getFirstAsync(`SELECT payload_json FROM ${SQLITE_LOCAL_TABLE} WHERE local_id = ?`, op.local_id);
    pendientes.push({ localId: op.local_id, payload, localPayload: local ? safeParse(local.payload_json, {}) : null });
  }
  await runSqliteTx(db, async (tx) => {
    for (const { localId, payload, localPayload } of pendientes) {
      const clientUuid = normalizeUuid(createClientUuid());
      const stamp = nowIso();
      await tx.runAsync(`UPDATE ${SQLITE_OUTBOX_TABLE} SET payload_json = ?, updated_at = ? WHERE local_id = ?`,
        JSON.stringify({ ...payload, client_uuid: clientUuid, client_uid: clientUuid }), stamp, localId);
      if (localPayload) {
        await tx.runAsync(`UPDATE ${SQLITE_LOCAL_TABLE} SET client_uuid = ?, payload_json = ?, updated_at = ? WHERE local_id = ?`,
          clientUuid, JSON.stringify({ ...localPayload, client_uuid: clientUuid, client_uid: clientUuid }), stamp, localId);
      }
    }
  });
  await setMetaValue(db, UUID_REGENERADO_FLAG_KEY, '1');
  console.log('[SYNC][UUID_REGENERADO]', { cargas: pendientes.length });
  return pendientes.length;
};

const ensureSqliteReady = async () => {
  if (sqliteInitPromise) {
    await sqliteInitPromise;
    return;
  }

  sqliteInitPromise = (async () => {
    const db = await getSqliteDb();
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS ${SQLITE_META_TABLE} (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${SQLITE_LOCAL_TABLE} (
        local_id TEXT PRIMARY KEY NOT NULL,
        remote_id TEXT,
        client_uuid TEXT,
        created_at TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0,
        sync_estado TEXT NOT NULL DEFAULT 'PENDIENTE',
        sync_error TEXT,
        sync_error_code TEXT,
        observaciones TEXT,
        latitud TEXT,
        longitud TEXT,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${SQLITE_OUTBOX_TABLE} (
        local_id TEXT PRIMARY KEY NOT NULL,
        op_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ack_at TEXT,
        server_id TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        last_error TEXT,
        last_error_code TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${SQLITE_LOCAL_TABLE}_client_uuid
      ON ${SQLITE_LOCAL_TABLE} (client_uuid);
      CREATE INDEX IF NOT EXISTS idx_${SQLITE_OUTBOX_TABLE}_status_next_retry
      ON ${SQLITE_OUTBOX_TABLE} (status, next_retry_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_${SQLITE_OUTBOX_TABLE}_status_started
      ON ${SQLITE_OUTBOX_TABLE} (status, started_at);
      CREATE INDEX IF NOT EXISTS idx_${SQLITE_LOCAL_TABLE}_created_at
      ON ${SQLITE_LOCAL_TABLE} (created_at DESC);
    `);

    await ensureSqliteColumn(db, SQLITE_LOCAL_TABLE, 'client_uuid', 'TEXT');
    await ensureSqliteColumn(db, SQLITE_OUTBOX_TABLE, 'started_at', 'TEXT');
    await ensureSqliteColumn(db, SQLITE_OUTBOX_TABLE, 'ack_at', 'TEXT');
    await ensureSqliteColumn(db, SQLITE_OUTBOX_TABLE, 'server_id', 'TEXT');
    await migrateAsyncStorageToSqliteIfNeeded(db);
    try {
      await regenerarUuidsMigradosNuncaEnviados(db);
    } catch (error) {
      // Sin flag, se reintenta en el próximo arranque; no debe impedir abrir la cola.
      console.warn('[SYNC][UUID_REGENERADO][ERROR]', error?.message);
    }
    await recoverStaleInFlightOperations(db);
  })();

  await sqliteInitPromise;
};

const sanitizeFileName = (value = 'archivo') =>
  String(value)
    .replace(/[^\w.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'archivo';

const inferMimeType = (uri = '', fallback = 'application/octet-stream') => {
  const lower = String(uri).toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return fallback;
};

const createSyncError = (code, message, details = {}) => {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
};

const isNetworkError = (error) => {
  // becasApi marca `network` en cualquier rechazo del fetch (Safari/iOS no usa los mismos textos).
  if (error?.network === true || error?.cause?.network === true) return true;
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('network request failed') ||
    message.includes('failed to fetch') ||
    message.includes('internet disconnected') ||
    message.includes('name_not_resolved') ||
    message.includes('err_name_not_resolved') ||
    message.includes('err_internet_disconnected') ||
    message.includes('unable to resolve host') ||
    message.includes('timed out') ||
    message.includes('network')
  );
};

const getConnectivitySnapshot = async () => {
  try {
    const state = await NetInfo.fetch();
    const isConnected = !!state?.isConnected;
    const isInternetReachable = state?.isInternetReachable;
    const hasInternet = isConnected && isInternetReachable !== false;
    return {
      hasInternet,
      isConnected,
      isInternetReachable,
      type: state?.type || 'unknown',
    };
  } catch (error) {
    return {
      hasInternet: false,
      isConnected: false,
      isInternetReachable: false,
      type: 'error',
      error: error?.message || 'NetInfo unavailable',
    };
  }
};

const ensureAttachmentsDir = async () => {
  const info = await FileSystem.getInfoAsync(ATTACHMENTS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(ATTACHMENTS_DIR, { intermediates: true });
  }
};

const buildPersistentName = ({ uri, fileName, fallbackPrefix = 'file' }) => {
  const sourceName = sanitizeFileName(fileName || String(uri || '').split('/').pop() || fallbackPrefix);
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}_${rand}_${sourceName}`;
};

const isRemoteUri = (uri = '') => String(uri).startsWith('http://') || String(uri).startsWith('https://');
const isPersistentUri = (uri = '') => String(uri).startsWith(ATTACHMENTS_DIR);
const isTemporaryPickerUri = (uri = '') => {
  const value = String(uri || '');
  return value.includes('/cache/ImagePicker/') || value.includes('/cache/');
};

const persistLocalFileIfNeeded = async ({ uri, fileName, mimeType, size }) => {
  if (!uri || isRemoteUri(uri) || isPersistentUri(uri)) {
    return { uri, mimeType, size };
  }

  if (Platform.OS === 'web') {
    return persistWebAttachment({ uri, mimeType: mimeType || inferMimeType(fileName), size });
  }

  await ensureAttachmentsDir();
  const sourceInfo = await FileSystem.getInfoAsync(uri, { size: true });
  const isContentUri = String(uri).startsWith('content://');
  if (!isContentUri && !sourceInfo.exists) {
    throw createSyncError(
      ERROR_MISSING_LOCAL_FILE,
      'Adjunto no disponible, volve a adjuntarlo',
      { uri }
    );
  }

  console.log('[SYNC][FILE][PERSIST_START]', {
    sourceUri: uri,
    fileName: fileName || null,
    sizeBytes: sourceInfo?.size || size || null,
    fromCache: isTemporaryPickerUri(uri),
  });

  const stableName = buildPersistentName({ uri, fileName });
  const stableUri = `${ATTACHMENTS_DIR}/${stableName}`;
  await FileSystem.copyAsync({ from: uri, to: stableUri });

  const stableInfo = await FileSystem.getInfoAsync(stableUri, { size: true });
  console.log('[SYNC][FILE][PERSIST_OK]', {
    sourceUri: uri,
    stableUri,
    sizeBytes: stableInfo?.size || null,
  });
  return {
    uri: stableUri,
    mimeType: mimeType || inferMimeType(fileName || stableUri),
    size: stableInfo?.size || size || null,
  };
};

const persistPayloadFiles = async (payload = {}) => {
  const nextPayload = { ...payload };
  const evidencias = Array.isArray(payload?.evidencias) ? payload.evidencias : [];
  const adjuntos = Array.isArray(payload?.adjuntos) ? payload.adjuntos : [];

  const persistedEvidencias = [];
  for (const item of evidencias) {
    const rawUri = item?.uri || '';
    if (!rawUri) continue;
    const persisted = await persistLocalFileIfNeeded({
      uri: rawUri,
      fileName: item?.nombre || rawUri.split('/').pop(),
      mimeType: item?.mimeType || 'image/jpeg',
      size: item?.size || null,
    });
    persistedEvidencias.push({
      ...item,
      uri: persisted.uri,
      mimeType: persisted.mimeType,
      size: persisted.size,
    });
  }

  const persistedAdjuntos = [];
  for (const item of adjuntos) {
    const rawUri = item?.uri || '';
    if (!rawUri) continue;
    const persisted = await persistLocalFileIfNeeded({
      uri: rawUri,
      fileName: item?.nombre || rawUri.split('/').pop(),
      mimeType: item?.mimeType || inferMimeType(item?.nombre || rawUri),
      size: item?.size || null,
    });
    persistedAdjuntos.push({
      ...item,
      uri: persisted.uri,
      mimeType: persisted.mimeType,
      size: persisted.size,
    });
  }

  nextPayload.evidencias = persistedEvidencias;
  nextPayload.adjuntos = persistedAdjuntos;
  return nextPayload;
};

export const validateFormularioAttachment = async (attachment) => {
  validateAttachmentMetadata(attachment);
  let size = attachment.size ?? attachment.fileSize;
  if (Platform.OS !== 'web') {
    const info = await FileSystem.getInfoAsync(attachment.uri, { size: true });
    if (info.exists) size = info.size ?? size;
  } else if (size == null && /^(blob:|data:)/.test(String(attachment.uri))) {
    size = (await readWebBlob(attachment.uri)).size;
  }
  validateAttachmentMetadata({ ...attachment, size });
};

const persistFormularioAttachments = async (payload = {}) => {
  if (payload.definicion_formulario?.acepta_respuestas !== true
    && (payload.campos_definicion || []).some(field => field.scope === 'propios')) {
    throw new Error('El servidor necesita actualizarse para recibir los campos propios de este formulario.');
  }
  const data = {
    ...(payload.data || {}),
    globales: { ...(payload?.data?.globales || {}) },
    requisitos: { ...(payload?.data?.requisitos || {}) },
    meta: { ...(payload?.data?.meta || {}) },
  };
  const attachments = [];
  const respuestas = payload.respuestas ? { ...payload.respuestas } : null;

  for (const field of payload.campos_definicion || []) {
    if (String(field?.tipo || '').toUpperCase() !== 'ARCHIVO') continue;
    const scope = field?.scope || 'globales';
    const fieldId = String(field?.original_id || field?.id || '');
    const attachmentKey = field.clave || `${scope}:${fieldId}`;
    const storedAttachment = (payload.adjuntos_formulario || []).find((item) => item.key === attachmentKey);
    const responseValue = respuestas?.[field.clave];
    const value = responseValue?.uri ? responseValue
      : data?.[scope]?.[fieldId]?.uri ? data[scope][fieldId] : storedAttachment;
    const rawUri = value?.uri || '';
    if (!fieldId || !rawUri) continue;

    const fileName = value?.fileName || value?.nombre || rawUri.split('/').pop() || `adjunto_${fieldId}`;
    await validateFormularioAttachment({ ...value, uri: rawUri, fileName });
    const persisted = await persistLocalFileIfNeeded({
      uri: rawUri,
      fileName,
      mimeType: value?.mimeType || inferMimeType(fileName),
      size: value?.size || null,
    });
    attachments.push({
      key: attachmentKey,
      clave: payload.definicion_formulario?.acepta_respuestas === true ? field.clave : null,
      scope,
      field_id: fieldId,
      uri: persisted.uri,
      fileName: sanitizeFileName(fileName),
      mimeType: persisted.mimeType,
      size: persisted.size,
      label: field?.etiqueta || field?.texto || '',
    });
    const placeholder = { archivo_adjunto: true, nombre: sanitizeFileName(fileName) };
    if (scope !== 'propios') data[scope][fieldId] = placeholder;
    if (respuestas && field.clave) respuestas[field.clave] = placeholder;
  }

  return { ...payload, ...(respuestas ? { respuestas } : {}), data, adjuntos_formulario: attachments };
};

const calculateBackoffMs = (retryCount = 0) => {
  const base = 2500;
  const max = 5 * 60 * 1000;
  return Math.min(max, base * (2 ** Math.max(0, retryCount)));
};

const readLocalRecords = async () => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const rows = await db.getAllAsync(
    `SELECT local_id, remote_id, client_uuid, created_at, synced, sync_estado, sync_error, sync_error_code, observaciones, latitud, longitud, payload_json
     FROM ${SQLITE_LOCAL_TABLE}
     ORDER BY created_at DESC`
  );
  return rows.map(mapLocalRow);
};

const isRemoteCacheRecord = (record = {}) =>
  record.payload?.cache_source === 'remote' || String(record.local_id || '').startsWith('remote_');

const mapLocalRecordForList = (record = {}) => {
  if (isRemoteCacheRecord(record)) {
    return {
      ...(record.payload || {}),
      id: record.remote_id || record.payload?.id,
      remote_id: record.remote_id || record.payload?.id,
      cached: true,
      sync_estado: record.payload?.sync_estado || record.sync_estado || 'SINCRONIZADO',
    };
  }

  return {
    id: record.local_id,
    id_institucion: 1,
    created_at: record.created_at,
    sync_estado: record.sync_estado || (record.synced ? 'SINCRONIZADO' : 'PENDIENTE'),
    observaciones: record.observaciones,
    latitud: record.latitud,
    longitud: record.longitud,
  };
};

const readCachedRemoteRecord = async (id, backend = 'django_becas') => {
  if (!id) return null;
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const row = await db.getFirstAsync(
    `SELECT local_id, remote_id, client_uuid, created_at, synced, sync_estado, sync_error, sync_error_code, observaciones, latitud, longitud, payload_json
     FROM ${SQLITE_LOCAL_TABLE}
     WHERE local_id = ?
     LIMIT 1`,
    createRemoteCacheId(backend, id)
  );
  if (!row) return null;
  const record = mapLocalRow(row);
  const ownerId = await getCurrentOwnerId();
  return belongsToOwner(record, ownerId) ? record : null;
};

const upsertCachedRemoteRecord = async (record = {}) => {
  if (!record?.id) return null;
  await ensureSqliteReady();
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return null;
  const db = await getSqliteDb();
  const backend = record.backend || 'django_becas';
  const localId = createRemoteCacheId(backend, record.id);
  const payload = {
    ...record,
    cache_source: 'remote',
    backend,
    _owner_user_id: ownerId,
    cached_at: nowIso(),
  };
  const createdAt = record.created_at || record.fecha_asignada || nowIso();

  await db.runAsync(
    `INSERT INTO ${SQLITE_LOCAL_TABLE}
    (local_id, remote_id, client_uuid, created_at, synced, sync_estado, sync_error, sync_error_code, observaciones, latitud, longitud, payload_json, updated_at)
    VALUES (?, ?, NULL, ?, 1, ?, NULL, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(local_id) DO UPDATE SET
      remote_id = excluded.remote_id,
      created_at = excluded.created_at,
      synced = 1,
      sync_estado = excluded.sync_estado,
      sync_error = NULL,
      sync_error_code = NULL,
      observaciones = excluded.observaciones,
      latitud = excluded.latitud,
      longitud = excluded.longitud,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`,
    localId,
    String(record.id),
    createdAt,
    record.sync_estado || 'SINCRONIZADO',
    record.observaciones || record.descripcion || record.titulo || '',
    record.latitud ?? '',
    record.longitud ?? '',
    JSON.stringify(payload),
    nowIso()
  );
  return payload;
};

const updateCachedRemoteFormularios = async (relevamientoId, formularios = []) => {
  const cached = await readCachedRemoteRecord(relevamientoId);
  if (!cached?.payload) return null;
  return upsertCachedRemoteRecord({
    ...cached.payload,
    cached_formularios: formularios,
    cached_formularios_at: nowIso(),
  });
};

const getLocalBecasFormularios = async (relevamientoId) => {
  const localRecords = await readLocalRecords();
  const ownerId = await getCurrentOwnerId();
  return localRecords
    .filter((record) => (
      belongsToOwner(record, ownerId)
      &&
      !isRemoteCacheRecord(record)
      && record.payload?.backend === 'django_becas'
      && String(record.payload?.relevamiento_id || record.payload?.relevamientoId || '') === String(relevamientoId)
    ))
    .map((record) => {
      const payload = record.payload || {};
      const estadoLocal = String(record.sync_estado || '').toUpperCase();
      const estado = record.synced
        ? 'ENVIADO'
        : (estadoLocal === 'DESCARTADO' ? 'DESCARTADO' : estadoLocal === 'ERROR' ? 'ERROR DE SINCRONIZACIÓN'
          : (estadoLocal === 'PARCIAL' ? 'SINCRONIZACIÓN PARCIAL' : 'PENDIENTE DE SINCRONIZACIÓN'));
      return {
        id: record.remote_id || payload.remote_formulario_id || record.local_id,
        remote_formulario_id: payload.remote_formulario_id || record.remote_id || null,
        local_id: record.local_id,
        client_uuid: record.client_uuid || payload.client_uuid || payload.client_uid,
        ciudadano_dni: payload?.datos_identificacion?.dni || '',
        ciudadano_nombre: payload?.datos_identificacion?.nombre || '',
        ciudadano_apellido: payload?.datos_identificacion?.apellido || '',
        datos_identificacion: payload.datos_identificacion || null,
        estado,
        sync_error: record.sync_error || null,
        sincronizado_tarde: !!payload.sincronizado_tarde,
        attachment_results: payload.attachment_results || {},
        local: true,
      };
    });
};

const mergeBecasFormularios = (remoteRecords = [], localRecords = []) => {
  const matches = (local, remote) => (local.client_uuid && local.client_uuid === remote.client_uuid)
    || String(local.id) === String(remote.id);
  const merged = remoteRecords.map((remote) => {
    const local = localRecords.find((item) => matches(item, remote));
    return local ? { ...local, ...remote, attachment_results: local.attachment_results } : remote;
  });
  return [...localRecords.filter((local) => !remoteRecords.some((remote) => matches(local, remote))), ...merged];
};

const relevamientoIdsInOutbox = async (ownerId, where) => {
  const db = await getSqliteDb();
  const rows = await db.getAllAsync(`SELECT payload_json FROM ${SQLITE_OUTBOX_TABLE} WHERE ${where}`);
  return new Set(rows.map((row) => ({ payload: safeParse(row.payload_json, {}) }))
    .filter((item) => belongsToOwner(item, ownerId)).map((item) => String(item.payload.relevamiento_id)));
};

// `incluirDescartadas`: para no podar la caché de un relevamiento que sale del listado
// mientras tenga descartadas; sin ella no se ven ni se pueden restaurar.
const pendingRelevamientoIds = async (ownerId, { incluirDescartadas = false } = {}) => {
  const statuses = ['PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT', ...(incluirDescartadas ? ['DISCARDED'] : [])];
  return relevamientoIdsInOutbox(ownerId, `status IN (${statuses.map((status) => `'${status}'`).join(', ')})`);
};

// Las mismas altas que lista getDiscardedOperations: con ellas el relevamiento sigue en la
// lista aunque esté vencido, para poder llegar a «Restaurar».
const discardedRelevamientoIds = (ownerId) => relevamientoIdsInOutbox(ownerId,
  "status = 'DISCARDED' AND type = 'insert_relevamiento'");

const mapCachedRecordsForList = async () => {
  const localRecords = await readLocalRecords();
  const ownerId = await getCurrentOwnerId();
  const pendingIds = await pendingRelevamientoIds(ownerId);
  const discardedIds = await discardedRelevamientoIds(ownerId);
  return localRecords
    .filter((record) => (
      belongsToOwner(record, ownerId)
      && (
        isRemoteCacheRecord(record)
        || record.payload?.backend !== 'django_becas'
      )
    ))
    .map(mapLocalRecordForList)
    .map((item) => ({
      ...item,
      has_pending_operations: pendingIds.has(String(item.id)),
      has_discarded_operations: discardedIds.has(String(item.id)),
    }));
};

const warmRemoteDetailCache = async (records = []) => {
  for (const record of records) {
    if (record?.backend !== 'django_becas' || !record?.id) {
      await upsertCachedRemoteRecord(record);
      continue;
    }

    const cached = await readCachedRemoteRecord(record.id, record.backend);
    if (cached?.payload?.cache_detail_ready) {
      await upsertCachedRemoteRecord({ ...cached.payload, ...record, cache_detail_ready: true });
      continue;
    }

    try {
      const payload = await becasRequest(`/api/becas/relevamientos/${record.id}/`);
      await upsertCachedRemoteRecord({
        ...mapDjangoRelevamientoDetail(payload),
        cache_detail_ready: true,
      });
    } catch {
      await upsertCachedRemoteRecord(record);
    }
  }
};

const pruneRemoteCacheForCurrentOwner = async (remoteRecords = []) => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return;
  const currentRemoteIds = new Set(remoteRecords.map((record) => String(record?.id || '')).filter(Boolean));
  const localRecords = await readLocalRecords();
  const db = await getSqliteDb();
  const pendingIds = await pendingRelevamientoIds(ownerId, { incluirDescartadas: true });
  const staleCacheIds = localRecords
    .filter((record) => (
      isRemoteCacheRecord(record)
      && belongsToOwner(record, ownerId)
      && !currentRemoteIds.has(String(record.remote_id || record.payload?.id || ''))
      && !pendingIds.has(String(record.remote_id || record.payload?.id || ''))
    ))
    .map((record) => record.local_id);
  if (!staleCacheIds.length) return;
  await runSqliteTx(db, async (tx) => {
    for (const localId of staleCacheIds) {
      await tx.runAsync(
        `DELETE FROM ${SQLITE_LOCAL_TABLE} WHERE local_id = ?`,
        localId
      );
    }
  });
};

const readQueue = async () => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const rows = await db.getAllAsync(
    `SELECT local_id, op_id, status, type, payload_json, created_at, started_at, ack_at, server_id, retry_count, next_retry_at, last_error, last_error_code
     FROM ${SQLITE_OUTBOX_TABLE}
     WHERE status = 'PENDING'
     ORDER BY created_at ASC,
       CASE
         WHEN type = 'iniciar_relevamiento' THEN 0
         WHEN type = 'finalizar_relevamiento' THEN 2
         ELSE 1
       END ASC`
  );
  const ownerId = await getCurrentOwnerId();
  return rows.map(mapOutboxRow).filter((record) => belongsToOwner(record, ownerId));
};

// Sube al backend las fotos de DNI ya capturadas por la cámara (hoy quedaban
// solo como URI local en data.meta.dni_fotos, sin llegar nunca al servidor).
// Matchea por texto del campo ARCHIVO ("Frente"/"Dorso") contra
// campos_definicion — el id real de la PreguntaGlobal no es fijo entre
// entornos. Si falla la subida de una foto no bloquea el alta del formulario:
// queda pendiente y se puede reintentar/cargar a mano desde el backoffice.
const subirAdjuntosDniFormulario = async (formularioId, camposDefinicion = [], dniFotos = {}) => {
  const archivos = (camposDefinicion || []).filter((f) => f.tipo === 'ARCHIVO');
  const campoFrente = archivos.find((f) => /frente/i.test(f.texto || ''));
  const campoDorso = archivos.find((f) => /dorso/i.test(f.texto || ''));
  const pendientes = [
    campoFrente?.original_id && dniFotos?.frente ? { field: campoFrente, uri: dniFotos.frente } : null,
    campoDorso?.original_id && dniFotos?.dorso ? { field: campoDorso, uri: dniFotos.dorso } : null,
  ].filter(Boolean);

  for (const { field, uri } of pendientes) {
    try {
      await becasUploadFile(`/api/becas/formularios/${formularioId}/adjuntos/`, {
        fileUri: uri,
        fields: { pregunta_global: field.original_id },
      });
    } catch (error) {
      console.warn(`No se pudo subir el adjunto "${field.texto}":`, error?.message);
    }
  }
};

const updateOutboxPayload = async (localId, payload) => {
  const db = await getSqliteDb();
  await runSqliteTx(db, async (tx) => {
    for (const table of [SQLITE_OUTBOX_TABLE, SQLITE_LOCAL_TABLE]) {
      await tx.runAsync(`UPDATE ${table} SET payload_json = ?, updated_at = ? WHERE local_id = ?`,
        JSON.stringify(payload), nowIso(), localId);
    }
  });
};

const syncRemoteBecasFormulario = async (operation) => {
  let payload = operation?.payload || {};
  const relevamientoId = payload.relevamiento_id || payload.relevamientoId;
  if (!relevamientoId) {
    throw new Error('Falta el relevamiento para sincronizar el formulario.');
  }

  let formularioId = payload.remote_formulario_id;
  if (!formularioId) {
    const formulario = await becasRequest(`/api/becas/relevamientos/${relevamientoId}/formularios/`, {
      method: 'POST',
      body: {
        celular: payload.celular,
        email_contacto: payload.email_contacto,
        apoderado_nombre: payload.apoderado_nombre || '',
        apoderado_apellido: payload.apoderado_apellido || '',
        apoderado_dni: payload.apoderado_dni || '',
        apoderado_genero: payload.apoderado_genero || '',
        apoderado_fecha_nacimiento: payload.apoderado_fecha_nacimiento || null,
        gps_lat: payload.gps_lat || null,
        gps_lng: payload.gps_lng || null,
        validado_renaper: !!payload.validado_renaper,
        client_uuid: payload.client_uuid || payload.client_uid || null,
        capturado_en: payload.capturado_en || payload.created_at || operation.created_at,
        version_capturada: payload.version_capturada ?? null,
        datos_identificacion: payload.datos_identificacion,
        data: payload.data || { globales: {}, requisitos: {} },
        ...(payload.definicion_formulario?.acepta_respuestas === true && payload.respuestas
          ? { respuestas: payload.respuestas } : {}),
      },
    });
    formularioId = formulario.id;
    payload = { ...payload, remote_formulario_id: formularioId, sincronizado_tarde: !!formulario.sincronizado_tarde };
    await updateOutboxPayload(operation.local_id, payload);
  }

  const uploadedKeys = new Set(payload.uploaded_attachment_keys || []);
  const attachmentResults = { ...(payload.attachment_results || {}) };
  let transientError = null;
  for (const attachment of payload.adjuntos_formulario || []) {
    if (uploadedKeys.has(attachment.key) || attachmentResults[attachment.key]) continue;
    try {
      await validateFormularioAttachment(attachment);
      const relationField = attachment.scope === 'requisitos' ? 'requisito_nativo' : 'pregunta_global';
      await becasUploadFile(`/api/becas/formularios/${formularioId}/adjuntos/`, {
        fileUri: attachment.uri,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fields: attachment.clave ? { clave: attachment.clave } : { [relationField]: attachment.field_id },
      });
      uploadedKeys.add(attachment.key);
    } catch (error) {
      const status = Number(error?.statusCode || error?.status || 0);
      // Sesión, acceso, pausa y cupo conservan su manejo de la cola completa.
      if (status === 401 || status === 403 || error?.payload?.pausado || error?.payload?.code === 'PAUSADO'
        || error?.payload?.code === 'CUPO_RELEVAMIENTO_COMPLETO') throw error;
      if (status >= 400 && status < 500 && status !== 429) {
        attachmentResults[attachment.key] = {
          status: status === 409 && error?.payload?.code === 'CASO_RESUELTO' ? 'DISCARDED' : 'REJECTED',
          code: error?.payload?.code || 'ADJUNTO_RECHAZADO',
          message: `${attachment.label || attachment.fileName || attachment.key}: ${error?.message || 'Adjunto rechazado'}`,
        };
      } else if (!status && !isNetworkError(error) && /adjunto.*(debe|superar)/i.test(error?.message || '')) {
        attachmentResults[attachment.key] = { status: 'REJECTED', code: 'ADJUNTO_INVALIDO', message: error.message };
      } else {
        transientError = transientError || createSyncError(ERROR_ATTACHMENTS_UPLOAD,
          `No se pudo subir ${attachment.label || attachment.fileName}: ${error.message}`,
          { status, cause: error, retryAfter: error?.retryAfter ?? null });
      }
    }
    payload = { ...payload, uploaded_attachment_keys: [...uploadedKeys], attachment_results: attachmentResults };
    await updateOutboxPayload(operation.local_id, payload);
  }
  if (transientError) throw transientError;
  const rejected = Object.values(attachmentResults).filter((item) => item.status === 'REJECTED');
  if (rejected.length) throw createSyncError(REJECTED_ATTACHMENTS,
    rejected.map((item) => item.message).join('\n'), { status: 400 });

  return {
    id: formularioId,
    observaciones: payload.observaciones || '',
    latitud: payload.gps_lat || '',
    longitud: payload.gps_lng || '',
  };
};

// El 200 de iniciar/finalizar/reabrir trae el estado real; si falta o no se conoce,
// vale el que se daba por hecho hasta ahora.
const estadoDeRespuesta = (row, fallback) => {
  const estado = String(row?.estado || '').toUpperCase();
  return ESTADOS_RELEVAMIENTO.includes(estado) ? estado : fallback;
};

// FINALIZANDO es un estado LOCAL (finalizar en cola, sin confirmar). El back no lo
// escribe: si llega de él y no queda ninguna operación de finalizar para ese
// relevamiento, las pantallas lo reciben como FINALIZADO.
export const normalizarEstadoRelevamiento = (record, finalizarPendientes = new Set()) => {
  if (!record || record.estado !== 'FINALIZANDO' || finalizarPendientes.has(String(record.id))) return record;
  return { ...record, estado: 'FINALIZADO', ...(record.sync_estado === 'FINALIZANDO' ? { sync_estado: 'SINCRONIZADO' } : {}) };
};

const normalizarEstadosFinalizando = async (records = []) => {
  if (!records.some((record) => record?.estado === 'FINALIZANDO')) return records;
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const rows = await db.getAllAsync(`SELECT payload_json FROM ${SQLITE_OUTBOX_TABLE}
    WHERE type = 'finalizar_relevamiento' AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')`);
  const ownerId = await getCurrentOwnerId();
  const pendientes = new Set(rows.map((row) => ({ payload: safeParse(row.payload_json, {}) }))
    .filter((item) => belongsToOwner(item, ownerId)).map((item) => String(item.payload.relevamiento_id)));
  return records.map((record) => normalizarEstadoRelevamiento(record, pendientes));
};

const updateCachedRelevamientoState = async (relevamientoId, estado, remoteRow = {}) => {
  const cached = await readCachedRemoteRecord(relevamientoId);
  const mappedRemote = Object.keys(remoteRow || {}).length ? mapDjangoRelevamiento(remoteRow) : {};
  return upsertCachedRemoteRecord({
    ...(cached?.payload || {}),
    ...mappedRemote,
    ...remoteRow,
    id: Number(relevamientoId) || relevamientoId,
    source: 'asignado',
    backend: 'django_becas',
    estado,
    sync_estado: estado === 'FINALIZADO' ? 'SINCRONIZADO' : estado,
  });
};

const syncRelevamientoAction = async (operation) => {
  const relevamientoId = operation?.payload?.relevamiento_id;
  const actions = {
    iniciar_relevamiento: 'iniciar',
    finalizar_relevamiento: 'finalizar',
    reabrir_relevamiento: 'reabrir',
  };
  const action = actions[operation?.type];
  const row = await becasRequest(`/api/becas/relevamientos/${relevamientoId}/${action}/`, {
    method: 'POST',
    body: { capturado_en: operation?.payload?.capturado_en || operation?.created_at || nowCorrectedIso() },
  });
  let estado = estadoDeRespuesta(row, action === 'finalizar' ? 'FINALIZADO' : 'EN_CURSO');
  // La operación se confirma acá mismo: ya no queda nada "sin confirmar".
  if (action === 'finalizar' && estado === 'FINALIZANDO') estado = 'FINALIZADO';
  await updateCachedRelevamientoState(relevamientoId, estado, row);
  return row;
};

const hasPendingFormularioOperations = async (relevamientoId) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const rows = await db.getAllAsync(
    `SELECT payload_json
     FROM ${SQLITE_OUTBOX_TABLE}
     WHERE type = 'insert_relevamiento'
       AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')`
  );
  return rows.some((row) => {
    const payload = safeParse(row.payload_json, {});
    return String(payload?.relevamiento_id || payload?.relevamientoId || '') === String(relevamientoId);
  });
};

const hasBlockingStartOperation = async (relevamientoId) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const row = await db.getFirstAsync(
    `SELECT 1
     FROM ${SQLITE_OUTBOX_TABLE}
     WHERE type = 'iniciar_relevamiento'
       AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')
       AND json_extract(payload_json, '$.relevamiento_id') = ?
     LIMIT 1`,
    Number(relevamientoId) || String(relevamientoId)
  );
  return !!row;
};

const enqueueRelevamientoAction = async (relevamientoId, type) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const localId = `action_${type}_${relevamientoId}`;
  const stamp = nowIso();
  const ownerId = await getCurrentOwnerId();
  const payload = {
    backend: 'django_becas',
    relevamiento_id: relevamientoId,
    capturado_en: nowCorrectedIso(),
    _owner_user_id: ownerId,
  };
  await db.runAsync(
    `INSERT INTO ${SQLITE_OUTBOX_TABLE}
    (local_id, op_id, type, payload_json, created_at, started_at, ack_at, server_id, retry_count, next_retry_at, last_error, last_error_code, status, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'PENDING', ?)
    ON CONFLICT(local_id) DO UPDATE SET
      op_id = excluded.op_id,
      type = excluded.type,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at,
      started_at = NULL,
      ack_at = NULL,
      server_id = NULL,
      retry_count = 0,
      next_retry_at = NULL,
      last_error = NULL,
      last_error_code = NULL,
      status = 'PENDING',
      updated_at = excluded.updated_at`,
    localId,
    createLocalId(),
    type,
    JSON.stringify(payload),
    stamp,
    stamp
  );
};

const syncSingleOperation = async (operation) => {
  if (['iniciar_relevamiento', 'finalizar_relevamiento', 'reabrir_relevamiento'].includes(operation?.type)) {
    return syncRelevamientoAction(operation);
  }
  if (operation?.payload?.backend === 'django_becas') {
    return syncRemoteBecasFormulario(operation);
  }

  throw createSyncError(
    ERROR_REMOTE_SCHEMA,
    'Sincronizacion legacy deshabilitada: la app usa solo Django.'
  );
};

const upsertLocalRecordAndEnqueue = async (payload) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const local_id = payload.local_id || createLocalId();
  const clientUuid = normalizeUuid(payload.client_uuid || payload.client_uid || createClientUuid());
  const createdAt = payload.created_at || nowIso();
  const normalizedPayload = {
    ...payload,
    client_uuid: clientUuid,
    client_uid: clientUuid,
  };
  const record = {
    local_id,
    remote_id: payload.remote_id || null,
    client_uuid: clientUuid,
    observaciones: payload.observaciones || '',
    latitud: payload.latitud || '',
    longitud: payload.longitud || '',
    sync_estado: payload.sync_estado || 'PENDIENTE',
    synced: !!payload.synced,
    created_at: createdAt,
    payload: normalizedPayload,
  };

  await runSqliteTx(db, async (tx) => {
    const updatedAt = nowIso();
    await tx.runAsync(
      `INSERT INTO ${SQLITE_LOCAL_TABLE}
      (local_id, remote_id, client_uuid, created_at, synced, sync_estado, sync_error, sync_error_code, observaciones, latitud, longitud, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(local_id) DO UPDATE SET
        remote_id = excluded.remote_id,
        client_uuid = excluded.client_uuid,
        created_at = excluded.created_at,
        synced = excluded.synced,
        sync_estado = excluded.sync_estado,
        sync_error = NULL,
        sync_error_code = NULL,
        observaciones = excluded.observaciones,
        latitud = excluded.latitud,
        longitud = excluded.longitud,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at`,
      record.local_id,
      record.remote_id,
      record.client_uuid || null,
      record.created_at,
      toSqliteBool(record.synced),
      record.sync_estado,
      record.observaciones || '',
      record.latitud ?? '',
      record.longitud ?? '',
      JSON.stringify(record.payload || {}),
      updatedAt
    );

    await tx.runAsync(
      `INSERT INTO ${SQLITE_OUTBOX_TABLE}
      (local_id, op_id, type, payload_json, created_at, started_at, ack_at, server_id, retry_count, next_retry_at, last_error, last_error_code, status, updated_at)
      VALUES (?, ?, 'insert_relevamiento', ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'PENDING', ?)
      ON CONFLICT(local_id) DO UPDATE SET
        op_id = excluded.op_id,
        type = excluded.type,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at,
        started_at = NULL,
        ack_at = NULL,
        server_id = NULL,
        retry_count = 0,
        next_retry_at = NULL,
        last_error = NULL,
        last_error_code = NULL,
        status = 'PENDING',
        updated_at = excluded.updated_at`,
      record.local_id,
      createLocalId(),
      JSON.stringify(record.payload || {}),
      record.created_at,
      updatedAt
    );
  });

  return record;
};

const markOutboxOperationInFlight = async (localId) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const startedAt = nowIso();
  const result = await db.runAsync(
    `UPDATE ${SQLITE_OUTBOX_TABLE}
     SET status = 'IN_FLIGHT',
         started_at = ?,
         updated_at = ?
     WHERE local_id = ?
       AND status = 'PENDING'`,
    startedAt,
    startedAt,
    localId
  );
  return Number(result?.changes || 0) > 0;
};

const markOperationSyncedAtomic = async (localId, remoteRow) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  await runSqliteTx(db, async (tx) => {
    const stamp = nowIso();
    await tx.runAsync(
      `UPDATE ${SQLITE_LOCAL_TABLE}
       SET remote_id = ?,
           synced = 1,
           sync_estado = 'SINCRONIZADO',
           sync_error = NULL,
           sync_error_code = NULL,
           observaciones = ?,
           latitud = ?,
           longitud = ?,
           updated_at = ?
       WHERE local_id = ?`,
      remoteRow?.id || null,
      remoteRow?.observaciones || '',
      remoteRow?.latitud ?? '',
      remoteRow?.longitud ?? '',
      stamp,
      localId
    );

    await tx.runAsync(
      `UPDATE ${SQLITE_OUTBOX_TABLE}
       SET status = 'SYNCED',
           ack_at = ?,
           server_id = ?,
           last_error = NULL,
           last_error_code = NULL,
           next_retry_at = NULL,
           started_at = NULL,
           updated_at = ?
       WHERE local_id = ?`,
      stamp,
      remoteRow?.id || null,
      stamp,
      localId
    );
  });
};

const markOperationRetryAtomic = async (localId, {
  retryCount,
  nextRetryAt,
  message,
  errorCode,
  localSyncEstado = 'PENDIENTE',
}) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  await runSqliteTx(db, async (tx) => {
    const stamp = nowIso();
    await tx.runAsync(
      `UPDATE ${SQLITE_LOCAL_TABLE}
       SET sync_estado = ?,
           synced = 0,
           sync_error = ?,
           sync_error_code = ?,
           updated_at = ?
       WHERE local_id = ?`,
      localSyncEstado,
      message || null,
      'RETRY',
      stamp,
      localId
    );

    await tx.runAsync(
      `UPDATE ${SQLITE_OUTBOX_TABLE}
       SET retry_count = ?,
           next_retry_at = ?,
           last_error = ?,
           last_error_code = ?,
           status = 'PENDING',
           started_at = NULL,
           updated_at = ?
       WHERE local_id = ?`,
      Number(retryCount || 0),
      nextRetryAt || null,
      message || null,
      errorCode || null,
      stamp,
      localId
    );
  });
};

const markOperationPermanentErrorAtomic = async (localId, {
  retryCount,
  message,
  errorCode,
  localSyncEstado = 'ERROR',
}) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  await runSqliteTx(db, async (tx) => {
    const stamp = nowIso();
    await tx.runAsync(
      `UPDATE ${SQLITE_LOCAL_TABLE}
       SET sync_estado = ?,
           synced = 0,
           sync_error = ?,
           sync_error_code = ?,
           updated_at = ?
       WHERE local_id = ?`,
      localSyncEstado,
      message || null,
      'PERMANENT',
      stamp,
      localId
    );

    await tx.runAsync(
      `UPDATE ${SQLITE_OUTBOX_TABLE}
       SET retry_count = ?,
           next_retry_at = NULL,
           last_error = ?,
           last_error_code = ?,
           status = 'FAILED_PERMANENT',
           started_at = NULL,
           updated_at = ?
       WHERE local_id = ?`,
      Number(retryCount || 0),
      message || null,
      errorCode || null,
      stamp,
      localId
    );
  });
};

// Cargas locales de ese relevamiento que el servidor todavía no conoce: el cupo que
// informa el back no las cuenta. `excludeLocalId` deja afuera la que se está editando.
export const countUnsentFormularios = async (relevamientoId, excludeLocalId = null) => {
  await ensureSqliteReady();
  const db = await getSqliteDb();
  const rows = await db.getAllAsync(
    `SELECT local_id, payload_json FROM ${SQLITE_OUTBOX_TABLE}
     WHERE type = 'insert_relevamiento' AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')`
  );
  const ownerId = await getCurrentOwnerId();
  return rows.filter((row) => {
    const item = { payload: safeParse(row.payload_json, {}) };
    return belongsToOwner(item, ownerId)
      && !item.payload.remote_formulario_id
      && row.local_id !== excludeLocalId
      && String(item.payload.relevamiento_id || item.payload.relevamientoId || '') === String(relevamientoId);
  }).length;
};

// Falla del servidor o de la red: dentro de la gracia la carga no se pierde aunque se
// agoten los reintentos. Sin la fecha en la caché no hay con qué decir que venció.
const isGraceActive = async (relevamientoId) => {
  try {
    const cached = await readCachedRemoteRecord(relevamientoId);
    const hasta = Date.parse(cached?.payload?.fecha_hasta || '');
    return !Number.isFinite(hasta) || ahoraCorregido().getTime() <= hasta + GRACE_MS;
  } catch {
    return true;
  }
};

// Back viejo: sin `code`, la pausa y un `capturado_en` adelantado por el reloj del
// teléfono llegan con el mismo 400 que un fuera de período genuino. Si la caché dice
// pausado, o la captura cae dentro del período en caché, es transitorio.
const FUERA_DE_PERIODO_SIN_CODE = /^la captura se realiz[oó] fuera del per[ií]odo asignado\.?$/i;
const esFueraDePeriodoTransitorio = async (operation, error) => {
  if (!FUERA_DE_PERIODO_SIN_CODE.test(String(error?.payload?.detail || '').trim())) return false;
  try {
    const cached = (await readCachedRemoteRecord(operation?.payload?.relevamiento_id))?.payload;
    if (!cached) return false;
    if (cached.pausado === true) return true;
    const capturado = Date.parse(operation?.payload?.capturado_en || '');
    const desde = Date.parse(cached.fecha_asignada || '');
    const hasta = Date.parse(cached.fecha_hasta || '');
    return [capturado, desde, hasta].every(Number.isFinite) && desde <= capturado && capturado <= hasta;
  } catch {
    return false;
  }
};

// El servidor ya tiene ese client_uuid en otra carga: se genera uno nuevo y se reintenta
// enseguida, sin consumir reintentos.
const regenerateClientUuid = async (operation) => {
  const db = await getSqliteDb();
  const clientUuid = normalizeUuid(createClientUuid());
  const payload = { ...operation.payload, client_uuid: clientUuid, client_uid: clientUuid, uuid_regenerado: true };
  await runSqliteTx(db, async (tx) => {
    const stamp = nowIso();
    await tx.runAsync(
      `UPDATE ${SQLITE_OUTBOX_TABLE}
       SET payload_json = ?, status = 'PENDING', started_at = NULL, next_retry_at = NULL,
           last_error = NULL, last_error_code = NULL, updated_at = ?
       WHERE local_id = ?`,
      JSON.stringify(payload), stamp, operation.local_id
    );
    await tx.runAsync(
      `UPDATE ${SQLITE_LOCAL_TABLE}
       SET client_uuid = ?, payload_json = ?, sync_estado = 'PENDIENTE', sync_error = NULL, sync_error_code = NULL, updated_at = ?
       WHERE local_id = ?`,
      clientUuid, JSON.stringify(payload), stamp, operation.local_id
    );
  });
  return payload;
};

const fetchRemoteRecords = async () => {
  const payload = await becasRequest('/api/becas/relevamientos/');
  const rows = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload) ? payload : []);
  return rows.map(mapDjangoRelevamiento);
};

const isLocalId = (id) => String(id || '').startsWith('local_rel_');

const relevamientoService = {
  async saveRelevamiento(payload) {
    throw new Error('saveRelevamiento legacy deshabilitado: la app usa solo Django.');
  },

  async saveBecasFormulario(payload) {
    await ensureSqliteReady();
    const ownerId = await getCurrentOwnerId();
    if (!ownerId) throw new Error('No hay un usuario autenticado para guardar datos offline.');
    const assigned = await readCachedRemoteRecord(payload?.relevamiento_id);
    if (!isDateTimeActive(assigned?.payload?.fecha_asignada, assigned?.payload?.fecha_hasta)) {
      throw new Error('Solo se pueden cargar casos dentro de la fecha y hora asignadas.');
    }
    const cupoMaximo = Number(payload?._cupo_maximo || 0);
    if (!payload.local_id) {
      // Con el cupo que informa el servidor se descuentan las cargas locales que todavía
      // no llegaron; sin esos datos (back viejo) vale el cálculo de siempre.
      let cupoAgotado = payload._cupo_completo === true;
      const disponible = cupoDisponibleConfiable({ cupo_disponible: payload._cupo_disponible, cupo_completo: payload._cupo_completo });
      if (!cupoAgotado && cupoMaximo > 0 && disponible != null) {
        cupoAgotado = disponible - await countUnsentFormularios(payload?.relevamiento_id) <= 0;
      }
      // Piso: el `cupo_disponible` del detalle se lee una sola vez y queda viejo cuando las
      // cargas locales se sincronizan; el conteo de siempre nunca deja cargar de más.
      if (!cupoAgotado && cupoMaximo > 0) {
        const existentes = (await getLocalBecasFormularios(payload?.relevamiento_id))
          .filter((item) => item.estado !== 'DESCARTADO' || item.remote_formulario_id);
        cupoAgotado = existentes.length >= cupoMaximo;
      }
      if (cupoAgotado) {
        const error = new Error('Se alcanzó el cupo del relevamiento. No se pueden cargar nuevas personas.');
        error.code = 'CUPO_RELEVAMIENTO_COMPLETO';
        throw error;
      }
    }
    const capturadoEn = payload?.capturado_en || payload?.created_at || nowCorrectedIso();
    if (payload.local_id) throw new Error('Usá corregirCasoFallido para corregir una captura existente.');
    const payloadWithFiles = await persistFormularioAttachments(payload);
    const localRecord = await upsertLocalRecordAndEnqueue({
      ...payloadWithFiles,
      _owner_user_id: ownerId,
      capturado_en: capturadoEn,
      backend: 'django_becas',
      sync_estado: 'PENDIENTE',
      synced: false,
      created_at: capturadoEn,
      observaciones: payload?.observaciones || payload?.datos_identificacion?.dni || '',
      latitud: payload?.gps_lat || '',
      longitud: payload?.gps_lng || '',
    });

    const syncPromise = this.syncPendingOperations();
    const syncResult = await Promise.race([
      syncPromise,
      new Promise((resolve) => {
        setTimeout(() => resolve({ synced: 0, failed: 0, background: true }), BACKGROUND_SYNC_WAIT_MS);
      }),
    ]);
    return { success: true, record: localRecord, syncResult };
  },

  async syncPendingOperations() {
    await ensureSqliteReady();
    if (syncInFlightPromise) {
      return syncInFlightPromise;
    }

    syncInFlightPromise = (async () => {
    const db = await getSqliteDb();
    await recoverStaleInFlightOperations(db);
    // Versiones anteriores guardaban como definitivo un rechazo HTML del proxy/WAF.
    // Es una falla transitoria del servidor: devolverla a la cola permite que la
    // sincronizacion automatica la recupere cuando el servicio vuelve a responder.
    await db.runAsync(
      `UPDATE ${SQLITE_OUTBOX_TABLE}
       SET status = 'PENDING', retry_count = 0, next_retry_at = NULL, started_at = NULL, updated_at = ?
       WHERE status = 'FAILED_PERMANENT'
         AND (last_error LIKE '%<!DOCTYPE html%' OR last_error LIKE '%pagina HTML inesperada%'
           OR last_error LIKE '%database is locked%')`,
      nowIso()
    );
    const queue = await readQueue();
    if (!queue.length) return { synced: 0, failed: 0, errors: [] };

    const connectivity = await getConnectivitySnapshot();
    if (!connectivity.hasInternet) {
      console.log('[SYNC][SKIP_OFFLINE]', {
        pending: queue.length,
        connectivity,
      });
      return {
        synced: 0,
        failed: 0,
        skipped: queue.length,
        offline: true,
        errors: [{ message: 'Sin conexion: adjuntos pendientes' }],
      };
    }

    let synced = 0;
    let failed = 0;
    const errors = [];
    const nowTs = Date.now();

    for (const operation of queue) {
      // Otra petición puede haber invalidado la sesión mientras sincronizábamos.
      if (!await getBecasToken()) break;
      const nextRetryAtTs = operation?.next_retry_at ? Date.parse(operation.next_retry_at) : null;
      if (nextRetryAtTs && Number.isFinite(nextRetryAtTs) && nextRetryAtTs > nowTs) {
        continue;
      }

      if (
        operation?.type === 'finalizar_relevamiento'
        && await hasPendingFormularioOperations(operation?.payload?.relevamiento_id)
      ) {
        continue;
      }
      if (
        operation?.type === 'insert_relevamiento'
        && await hasBlockingStartOperation(operation?.payload?.relevamiento_id)
      ) {
        continue;
      }

      const acquired = await markOutboxOperationInFlight(operation.local_id);
      if (!acquired) {
        continue;
      }

      try {
        console.log('[SYNC][OP][START]', {
          op_id: operation?.op_id,
          local_id: operation?.local_id,
          retry_count: operation?.retry_count || 0,
          next_retry_at: operation?.next_retry_at || null,
          attachments: {
            evidencias: operation?.payload?.evidencias?.length || 0,
            adjuntos: operation?.payload?.adjuntos?.length || 0,
          },
        });
        const remoteRow = await syncSingleOperation(operation);
        await markOperationSyncedAtomic(operation.local_id, remoteRow);
        synced += 1;
      } catch (error) {
        const status = Number(error?.statusCode || error?.status || 0);
        const causeStatus = Number(error?.cause?.status || 0);
        const apiCode = error?.payload?.code || error?.cause?.payload?.code || null;
        if (status === 409 && apiCode === ERROR_CLIENT_UUID_EN_USO && operation.type === 'insert_relevamiento'
          && !operation.payload?.remote_formulario_id && !operation.payload?.uuid_regenerado) {
          try {
            const payload = await regenerateClientUuid(operation);
            // Reintento inmediato: se vuelve a procesar al final de esta misma pasada.
            queue.push({ ...operation, payload, next_retry_at: null });
            continue;
          } catch (regenerateError) {
            console.warn('[SYNC][UUID_EN_USO][ERROR]', regenerateError?.message);
          }
        }
        failed += 1;
        if (status === 401 || causeStatus === 401) {
          await markOperationRetryAtomic(operation.local_id, {
            retryCount: operation?.retry_count || 0,
            nextRetryAt: null,
            message: 'Volvé a iniciar sesión para continuar la sincronización.',
            errorCode: 'AUTH_REQUIRED',
            localSyncEstado: error?.code === ERROR_ATTACHMENTS_UPLOAD ? 'PARCIAL' : 'PENDIENTE',
          });
          errors.push({ local_id: operation.local_id, message: 'Sesión vencida', code: 'AUTH_REQUIRED' });
          break;
        }
        // El usuario no tiene la capacidad de campo: igual que el 401 corta la pasada y no
        // consume reintentos, pero el token sigue vigente y el sync corre cada pocos
        // segundos; sin next_retry_at le pegaría al servidor sin parar.
        // Un 403 con la página HTML del WAF no es del usuario: sigue el camino de `unexpectedHtml`.
        if ((status === 403 || causeStatus === 403) && !error?.unexpectedHtml && !error?.cause?.unexpectedHtml) {
          const message = 'Tu usuario no tiene acceso a la app de campo. Avisá al coordinador.';
          await markOperationRetryAtomic(operation.local_id, {
            retryCount: operation?.retry_count || 0,
            nextRetryAt: new Date(Date.now() + PAUSED_RETRY_MS).toISOString(),
            message,
            errorCode: ERROR_SIN_ACCESO,
            localSyncEstado: error?.code === ERROR_ATTACHMENTS_UPLOAD ? 'PARCIAL' : 'PENDIENTE',
          });
          errors.push({ local_id: operation.local_id, message, code: ERROR_SIN_ACCESO });
          break;
        }
        // Una pausa es transitoria. La captura ya está persistida en SQLite y
        // debe permanecer en la cola hasta que el backoffice la reanude. Se lee el
        // `code` primero; `pausado` y el texto quedan de respaldo para el back viejo.
        const paused = apiCode === 'PAUSADO' || error?.payload?.pausado === true
          || (status === 409 && /pausad/i.test(String(error?.message || '')));
        // El 400 de fuera de período del back viejo (ver esFueraDePeriodoTransitorio)
        // espera como una pausa, pero solo hasta que vence la gracia.
        const oldBackPause = !paused && status === 400 && !apiCode && operation.type === 'insert_relevamiento'
          && !operation.payload?.remote_formulario_id && await esFueraDePeriodoTransitorio(operation, error);
        const oldBackPauseExpired = oldBackPause && !await isGraceActive(operation?.payload?.relevamiento_id);
        const graceExpired = isGraceExpired(error) || oldBackPauseExpired;
        const pausedUntilGrace = paused || (oldBackPause && !oldBackPauseExpired);
        // La pausa gana: un back viejo la contestaba con 400.
        const invalidSubmission = status === 400 && operation.type === 'insert_relevamiento' && !paused && !oldBackPause
          && !operation.payload?.remote_formulario_id && error?.code !== REJECTED_ATTACHMENTS;
        const unexpectedServerPage = error?.unexpectedHtml === true || error?.cause?.unexpectedHtml === true;
        // 404: el relevamiento ya no es del usuario o no existe. Queda fallida y exportable.
        const notFound = status === 404 && !unexpectedServerPage;
        // 429: el servidor pide esperar; respeta Retry-After y, sin él, 5 minutos.
        const rateLimited = status === 429 || causeStatus === 429;
        const retryAfterMs = error?.retryAfter ?? error?.cause?.retryAfter ?? null;
        const waits = pausedUntilGrace || unexpectedServerPage || rateLimited;
        const retriable = waits || isNetworkError(error) || isNetworkError(error?.cause) || (status >= 500 && status <= 599);
        let retryCount = waits ? (operation?.retry_count || 0) : (operation?.retry_count || 0) + 1;
        // Las pausas y el 429 no consumen el máximo de reintentos: pueden durar horas o días.
        let canRetry = waits || (retriable && retryCount <= MAX_RETRY_COUNT);
        let retryDelayMs = rateLimited ? (retryAfterMs ?? PAUSED_RETRY_MS)
          : waits ? PAUSED_RETRY_MS : calculateBackoffMs(retryCount);
        // Agotados los reintentos, dentro de la gracia la carga sigue en la cola (cada 5 min,
        // con el contador topeado); pasada la gracia se comporta como siempre.
        if (!canRetry && retriable && await isGraceActive(operation?.payload?.relevamiento_id)) {
          canRetry = true;
          retryCount = MAX_RETRY_COUNT;
          retryDelayMs = PAUSED_RETRY_MS;
        }
        const nextRetry = canRetry ? new Date(Date.now() + retryDelayMs).toISOString() : null;
        const errorCode = graceExpired ? GRACE_EXPIRED : invalidSubmission ? INVALID_SUBMISSION
          : pausedUntilGrace ? ERROR_RELEVAMIENTO_PAUSADO : notFound ? ERROR_RELEVAMIENTO_NO_DISPONIBLE
          : (error?.code || apiCode || null);
        const message = errorCode === ERROR_MISSING_LOCAL_FILE
          ? 'Adjunto no disponible, volve a adjuntarlo'
          : graceExpired ? 'El relevamiento cerró hace más de 24 horas. Avisá al coordinador para recuperar esta captura.'
          : oldBackPause ? 'El relevamiento no acepta cargas por ahora (pausado o reloj del teléfono adelantado). Se reintenta sola.'
          : notFound ? 'Relevamiento reasignado o inexistente'
          : (error?.message || 'Error desconocido');
        const localSyncEstado = errorCode === ERROR_ATTACHMENTS_UPLOAD ? 'PARCIAL' : 'PENDIENTE';

        console.warn('[SYNC][OP][ERROR]', {
          op_id: operation?.op_id,
          local_id: operation?.local_id,
          status,
          retriable,
          canRetry,
          error_code: errorCode,
          retry_count: retryCount,
          next_retry_at: nextRetry,
          message,
          stack: error?.stack || null,
        });

        if (canRetry) {
          await markOperationRetryAtomic(operation.local_id, {
            retryCount,
            nextRetryAt: nextRetry,
            message,
            errorCode,
            localSyncEstado,
          });
        } else {
          await markOperationPermanentErrorAtomic(operation.local_id, {
            retryCount,
            message,
            errorCode,
            localSyncEstado: [ERROR_ATTACHMENTS_UPLOAD, REJECTED_ATTACHMENTS].includes(errorCode) ? 'PARCIAL' : 'ERROR',
          });
        }

        errors.push({
          local_id: operation.local_id,
          message,
          code: errorCode,
        });
      }
    }

    return { synced, failed, errors };
    })();

    try {
      return await syncInFlightPromise;
    } finally {
      syncInFlightPromise = null;
    }
  },

  async getPendingCount() {
    await ensureSqliteReady();
    const db = await getSqliteDb();
    const rows = await db.getAllAsync(
      `SELECT payload_json
       FROM ${SQLITE_OUTBOX_TABLE}
       WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')`
    );
    const ownerId = await getCurrentOwnerId();
    return rows
      .map((row) => ({ payload: safeParse(row.payload_json, {}) }))
      .filter((record) => belongsToOwner(record, ownerId))
      .length;
  },

  async getFailedOperations(relevamientoId) {
    await ensureSqliteReady();
    const db = await getSqliteDb();
    const rows = await db.getAllAsync(`SELECT * FROM ${SQLITE_OUTBOX_TABLE} WHERE status = 'FAILED_PERMANENT' ORDER BY created_at`);
    const ownerId = await getCurrentOwnerId();
    return rows.map(mapOutboxRow).filter((op) => belongsToOwner(op, ownerId)
      && (relevamientoId == null || String(op.payload.relevamiento_id) === String(relevamientoId)));
  },

  async getDiscardedOperations(relevamientoId) {
    await ensureSqliteReady();
    const db = await getSqliteDb();
    const rows = await db.getAllAsync(`SELECT * FROM ${SQLITE_OUTBOX_TABLE} WHERE status = 'DISCARDED' AND type = 'insert_relevamiento' ORDER BY created_at`);
    const ownerId = await getCurrentOwnerId();
    return rows.map(mapOutboxRow).filter((op) => belongsToOwner(op, ownerId)
      && (relevamientoId == null || String(op.payload.relevamiento_id) === String(relevamientoId)));
  },

  // Deshace un descarte: la captura vuelve a la cola como nueva (sin reintentos ni errores).
  async restoreDiscardedOperation(localId) {
    await ensureSqliteReady();
    if (syncInFlightPromise) await syncInFlightPromise;
    const operation = (await this.getDiscardedOperations()).find((item) => item.local_id === localId);
    if (!operation) throw new Error('La operación ya no está descartada o no pertenece al usuario actual.');
    const db = await getSqliteDb();
    await runSqliteTx(db, async (tx) => {
      const stamp = nowIso();
      await tx.runAsync(`UPDATE ${SQLITE_OUTBOX_TABLE} SET status = 'PENDING', retry_count = 0,
        next_retry_at = NULL, started_at = NULL, last_error = NULL, last_error_code = NULL, updated_at = ?
        WHERE local_id = ? AND status = 'DISCARDED'`, stamp, localId);
      await tx.runAsync(`UPDATE ${SQLITE_LOCAL_TABLE} SET sync_estado = 'PENDIENTE', synced = 0,
        sync_error = NULL, sync_error_code = NULL, updated_at = ? WHERE local_id = ?`, stamp, localId);
    });
    return { restored: localId, syncResult: await this.syncPendingOperations() };
  },

  // Reemplaza un adjunto que el servidor rechazó, sin tocar el caso ya creado: el back
  // reemplaza el adjunto por clave. Conserva remote_formulario_id y los demás adjuntos.
  async replaceRejectedAttachment(localId, attachmentKey, asset = {}) {
    await ensureSqliteReady();
    if (syncInFlightPromise) await syncInFlightPromise;
    const operation = await this.getFailedOperation(localId);
    const payload = operation.payload;
    const attachments = payload.adjuntos_formulario || [];
    const index = attachments.findIndex((item) => item.key === attachmentKey);
    if (operation.type !== 'insert_relevamiento' || index < 0
      || payload.attachment_results?.[attachmentKey]?.status !== 'REJECTED') {
      throw new Error('Solo se puede reemplazar un adjunto rechazado por el servidor.');
    }
    const fileName = asset.fileName || String(asset.uri || '').split('/').pop() || attachments[index].fileName;
    await validateFormularioAttachment({ ...asset, fileName });
    const persisted = await persistLocalFileIfNeeded({
      uri: asset.uri,
      fileName,
      mimeType: asset.mimeType || inferMimeType(fileName),
      size: asset.size || null,
    });
    const attachmentResults = { ...(payload.attachment_results || {}) };
    delete attachmentResults[attachmentKey];
    const nextPayload = {
      ...payload,
      adjuntos_formulario: attachments.map((item, i) => (i === index ? {
        ...item,
        uri: persisted.uri,
        fileName: sanitizeFileName(fileName),
        mimeType: persisted.mimeType,
        size: persisted.size,
      } : item)),
      attachment_results: attachmentResults,
      uploaded_attachment_keys: (payload.uploaded_attachment_keys || []).filter((key) => key !== attachmentKey),
    };
    const db = await getSqliteDb();
    await runSqliteTx(db, async (tx) => {
      const stamp = nowIso();
      const updated = await tx.runAsync(`UPDATE ${SQLITE_OUTBOX_TABLE} SET payload_json = ?, status = 'PENDING', retry_count = 0,
        next_retry_at = NULL, started_at = NULL, last_error = NULL, last_error_code = NULL, updated_at = ?
        WHERE local_id = ? AND status = 'FAILED_PERMANENT'`, JSON.stringify(nextPayload), stamp, localId);
      // Si ya no está fallida (otro camino la tomó) no se toca la tabla local.
      if (Number(updated?.changes || 0) !== 1) throw new Error('La operación ya no está fallida.');
      // El caso ya existe en el servidor: hasta que termine de subir queda como parcial.
      await tx.runAsync(`UPDATE ${SQLITE_LOCAL_TABLE} SET payload_json = ?, sync_estado = ?, synced = 0,
        sync_error = NULL, sync_error_code = NULL, updated_at = ? WHERE local_id = ?`,
      JSON.stringify(nextPayload), payload.remote_formulario_id ? 'PARCIAL' : 'PENDIENTE', stamp, localId);
    });
    return { success: true, syncResult: await this.syncPendingOperations() };
  },

  async countUnsentFormularios(relevamientoId, excludeLocalId = null) {
    return countUnsentFormularios(relevamientoId, excludeLocalId);
  },

  async getFailedOperation(localId) {
    const operations = await this.getFailedOperations();
    const operation = operations.find((item) => item.local_id === localId);
    if (!operation) throw new Error('La operación ya no está fallida o no pertenece al usuario actual.');
    return operation;
  },

  async discardFailedOperation(localId) {
    const operation = await this.getFailedOperation(localId);
    const db = await getSqliteDb();
    await runSqliteTx(db, async (tx) => {
      await tx.runAsync(`UPDATE ${SQLITE_OUTBOX_TABLE} SET status = 'DISCARDED', updated_at = ?
        WHERE local_id = ? AND status = 'FAILED_PERMANENT'`, nowIso(), localId);
      await tx.runAsync(`UPDATE ${SQLITE_LOCAL_TABLE} SET sync_estado = 'DESCARTADO', updated_at = ? WHERE local_id = ?`, nowIso(), localId);
    });
    // Se conserva el payload y los archivos para recuperar la captura.
    return { discarded: operation.local_id, syncResult: await this.syncPendingOperations() };
  },

  async correctFailedFormulario(localId, changes) {
    const operation = await this.getFailedOperation(localId);
    if (operation.type !== 'insert_relevamiento' || operation.payload.remote_formulario_id
      || operation.last_error_code !== INVALID_SUBMISSION) throw new Error('Solo se puede corregir un alta rechazada por sus datos.');
    const original = operation.payload;
    const payload = await persistFormularioAttachments({
      ...original, ...changes,
      local_id: operation.local_id,
      _owner_user_id: original._owner_user_id,
      relevamiento_id: original.relevamiento_id,
      client_uuid: original.client_uuid,
      client_uid: original.client_uid,
      capturado_en: original.capturado_en || operation.created_at,
      version_capturada: original.version_capturada,
      definicion_formulario: original.definicion_formulario,
      created_at: original.created_at || operation.created_at,
      synced: false, sync_estado: 'PENDIENTE',
    });
    const record = await upsertLocalRecordAndEnqueue(payload);
    return { success: true, record, syncResult: await this.syncPendingOperations() };
  },

  async exportFailedOperation(localId) {
    const operation = await this.getFailedOperation(localId);
    const attachments = [];
    if (Platform.OS === 'web') {
      for (const attachment of operation.payload.adjuntos_formulario || []) {
        try {
          const persisted = await persistWebAttachment(attachment);
          attachments.push({ ...attachment, content_base64: persisted.uri.split(',')[1] });
        } catch {
          attachments.push({ ...attachment, export_error: 'Archivo no disponible en el navegador' });
        }
      }
    } else {
      for (const attachment of operation.payload.adjuntos_formulario || []) {
        try {
          const content = await FileSystem.readAsStringAsync(attachment.uri, { encoding: FileSystem.EncodingType.Base64 });
          attachments.push({ ...attachment, content_base64: content });
        } catch {
          attachments.push({ ...attachment, export_error: 'Archivo no disponible en el teléfono' });
        }
      }
    }
    return JSON.stringify({ exported_at: nowIso(), operation, attachments }, null, 2);
  },

  async retryFailedOperations() {
    await ensureSqliteReady();
    if (syncInFlightPromise) await syncInFlightPromise;
    const db = await getSqliteDb();
    const operations = await this.getFailedOperations();
    const needsDecision = [GRACE_EXPIRED, INVALID_SUBMISSION, REJECTED_ATTACHMENTS];
    await runSqliteTx(db, async (tx) => {
      for (const operation of operations) {
        if (needsDecision.includes(operation.last_error_code)) continue;
        // Un reintento manual da derecho a una nueva regeneración del identificador.
        if (operation.last_error_code === ERROR_CLIENT_UUID_EN_USO && operation.payload.uuid_regenerado) {
          const payloadJson = JSON.stringify({ ...operation.payload, uuid_regenerado: false });
          for (const table of [SQLITE_OUTBOX_TABLE, SQLITE_LOCAL_TABLE]) {
            await tx.runAsync(`UPDATE ${table} SET payload_json = ?, updated_at = ? WHERE local_id = ?`,
              payloadJson, nowIso(), operation.local_id);
          }
        }
        await tx.runAsync(`UPDATE ${SQLITE_OUTBOX_TABLE} SET status = 'PENDING', retry_count = 0,
          next_retry_at = NULL, started_at = NULL, last_error = NULL, last_error_code = NULL, updated_at = ?
          WHERE local_id = ? AND status = 'FAILED_PERMANENT'`, nowIso(), operation.local_id);
        await tx.runAsync(`UPDATE ${SQLITE_LOCAL_TABLE} SET sync_estado = 'PENDIENTE',
          sync_error = NULL, sync_error_code = NULL, updated_at = ? WHERE local_id = ?`, nowIso(), operation.local_id);
      }
    });
    // Sincronizacion manual: el PM fuerza la subida, asi que el backoff (red, 5xx, 409, 429)
    // no frena a las cargas PENDING del usuario. Un solo intento por toque; si vuelven a
    // fallar, quedan en espera como siempre. Las IN_FLIGHT no se tocan.
    const ownerId = await getCurrentOwnerId();
    const enEspera = await db.getAllAsync(
      `SELECT * FROM ${SQLITE_OUTBOX_TABLE} WHERE status = 'PENDING' AND next_retry_at IS NOT NULL`
    );
    for (const row of enEspera) {
      if (!belongsToOwner(mapOutboxRow(row), ownerId)) continue;
      await db.runAsync(
        `UPDATE ${SQLITE_OUTBOX_TABLE} SET next_retry_at = NULL, updated_at = ?
         WHERE local_id = ? AND status = 'PENDING'`, nowIso(), row.local_id
      );
    }
    const result = await this.syncPendingOperations();
    const unresolved = await this.getFailedOperations();
    const reported = new Set((result.errors || []).map((item) => item.local_id));
    return { ...result, failed: Math.max(result.failed, unresolved.length), errors: [
      ...(result.errors || []),
      ...unresolved.filter((item) => !reported.has(item.local_id)).map((item) => ({
        local_id: item.local_id, message: item.last_error, code: item.last_error_code,
      })),
    ] };
  },

  async getRelevamientos(options) {
    const result = await this.leerRelevamientos(options);
    return result?.records ? { ...result, records: await normalizarEstadosFinalizando(result.records) } : result;
  },

  async leerRelevamientos({ refreshFromRemote = true } = {}) {
    const ownerId = await getCurrentOwnerId();
    if (refreshFromRemote) {
      const connectivity = await getConnectivitySnapshot();
      if (!connectivity.hasInternet) {
        const cached = await mapCachedRecordsForList();
        return {
          success: cached.length > 0,
          records: cached,
          offline: true,
          error: cached.length ? '' : 'Sin conexion y sin relevamientos descargados',
        };
      }

      try {
        await this.syncPendingOperations();
        const remote = await fetchRemoteRecords();
        await warmRemoteDetailCache(remote);
        await pruneRemoteCacheForCurrentOwner(remote);
        const localRecords = await readLocalRecords();
        const pendingLocal = localRecords
          .filter((item) => (
            belongsToOwner(item, String(ownerId))
            && !item.synced
            && !isRemoteCacheRecord(item)
            // Los formularios de Becas usan la misma tabla offline, pero no son
            // relevamientos y nunca deben aparecer como tarjetas en la agenda.
            && item.payload?.backend !== 'django_becas'
          ))
          .map(mapLocalRecordForList);
        const retained = await mapCachedRecordsForList();
        const pendingIds = new Set(retained.filter((item) => item.has_pending_operations).map((item) => String(item.id)));
        const discardedIds = new Set(retained.filter((item) => item.has_discarded_operations).map((item) => String(item.id)));
        return { success: true, records: uniqueBy([...pendingLocal, ...remote, ...retained], (item) => String(item.id))
          .map((item) => ({
            ...item,
            has_pending_operations: pendingIds.has(String(item.id)),
            has_discarded_operations: discardedIds.has(String(item.id)),
          })) };
      } catch (error) {
        const fallback = await mapCachedRecordsForList();
        return {
          success: fallback.length > 0,
          records: fallback,
          offline: isNetworkError(error),
          error: fallback.length ? '' : (error?.message || 'Modo offline'),
        };
      }
    }

    const mapped = await mapCachedRecordsForList();
    return { success: true, records: mapped };
  },

  async getBecasFormularios(relevamientoId, { refreshFromRemote = true } = {}) {
    if (!relevamientoId) return { success: false, records: [], error: 'ID invalido' };
    const localRecords = await getLocalBecasFormularios(relevamientoId);
    const connectivity = await getConnectivitySnapshot();
    if (!refreshFromRemote || !connectivity.hasInternet) {
      const cached = await readCachedRemoteRecord(relevamientoId);
      return {
        success: true,
        records: mergeBecasFormularios(cached?.payload?.cached_formularios || [], localRecords),
        offline: !connectivity.hasInternet,
      };
    }

    try {
      const payload = await becasRequest(`/api/becas/relevamientos/${relevamientoId}/formularios/`);
      const records = Array.isArray(payload)
        ? payload
        : (payload?.results || payload?.data || []);
      await updateCachedRemoteFormularios(relevamientoId, records);
      return { success: true, records: mergeBecasFormularios(records, localRecords) };
    } catch (error) {
      const cached = await readCachedRemoteRecord(relevamientoId);
      const cachedRecords = cached?.payload?.cached_formularios || [];
      return {
        success: cachedRecords.length > 0 || localRecords.length > 0,
        records: mergeBecasFormularios(cachedRecords, localRecords),
        offline: isNetworkError(error),
        error: cachedRecords.length ? '' : (error?.message || 'No se pudieron cargar los formularios'),
      };
    }
  },

  // Bloquea si hay una carga local sin sincronizar o un caso ENVIADO/APROBADO (o de
  // estado desconocido) con ese DNI; con solo RECHAZADO o BAJA avisa pero deja cargar.
  async evaluarDniDuplicado(relevamientoId, dni, excludeLocalId = null) {
    const normalizedDni = String(dni || '').replace(/\D/g, '');
    const libre = { bloquear: false, avisar: false, estado: null };
    if (!relevamientoId || !normalizedDni) return libre;
    const result = await this.getBecasFormularios(relevamientoId);
    const coincidencias = (result.records || []).filter((formulario) => {
      if (excludeLocalId && formulario.local_id === excludeLocalId) return false;
      if (formulario.estado === 'DESCARTADO') return false;
      const formularioDni = formulario?.ciudadano_dni || formulario?.datos_identificacion?.dni || '';
      return String(formularioDni).replace(/\D/g, '') === normalizedDni;
    });
    const liberan = ['RECHAZADO', 'BAJA'];
    const bloqueante = coincidencias.find((formulario) => !liberan.includes(String(formulario.estado || '').toUpperCase()));
    if (bloqueante) return { bloquear: true, avisar: false, estado: bloqueante.estado || null };
    return coincidencias.length ? { bloquear: false, avisar: true, estado: coincidencias[0].estado } : libre;
  },

  async dniYaRelevado(relevamientoId, dni, excludeLocalId = null) {
    return (await this.evaluarDniDuplicado(relevamientoId, dni, excludeLocalId)).bloquear;
  },

  async iniciarRelevamiento(relevamientoId) {
    if (!relevamientoId) return { success: false, error: 'ID invalido' };
    const cached = await readCachedRemoteRecord(relevamientoId);
    if (!isDateTimeActive(cached?.payload?.fecha_asignada, cached?.payload?.fecha_hasta)) {
      return { success: false, error: 'Solo se puede iniciar el relevamiento dentro de la fecha y hora asignadas.' };
    }
    const connectivity = await getConnectivitySnapshot();
    if (!connectivity.hasInternet) {
      await enqueueRelevamientoAction(relevamientoId, 'iniciar_relevamiento');
      const detail = await updateCachedRelevamientoState(relevamientoId, 'EN_CURSO');
      return { success: true, estado: 'EN_CURSO', detail, offline: true, pending: true };
    }
    try {
      const row = await becasRequest(`/api/becas/relevamientos/${relevamientoId}/iniciar/`, {
        method: 'POST',
      });
      const estado = estadoDeRespuesta(row, 'EN_CURSO');
      const detail = await updateCachedRelevamientoState(relevamientoId, estado, row);
      return { success: true, estado, detail };
    } catch (error) {
      return { success: false, error: error?.message || 'No se pudo iniciar el relevamiento.' };
    }
  },

  async finalizarRelevamiento(relevamientoId) {
    if (!relevamientoId) return { success: false, error: 'ID invalido' };
    await enqueueRelevamientoAction(relevamientoId, 'finalizar_relevamiento');
    await updateCachedRelevamientoState(relevamientoId, 'FINALIZANDO');
    const syncResult = await this.syncPendingOperations();
    const cached = await readCachedRemoteRecord(relevamientoId);
    const estado = cached?.payload?.estado || 'FINALIZANDO';
    return {
      success: true,
      estado,
      pending: estado === 'FINALIZANDO',
      offline: !!syncResult?.offline,
      detail: cached?.payload || { id: relevamientoId, estado },
      syncResult,
    };
  },

  async reabrirRelevamiento(relevamientoId) {
    if (!relevamientoId) return { success: false, error: 'ID invalido' };
    const connectivity = await getConnectivitySnapshot();
    if (!connectivity.hasInternet) {
      return { success: false, offline: true, error: 'Necesitas conexion para reabrir el relevamiento.' };
    }
    try {
      const row = await becasRequest(`/api/becas/relevamientos/${relevamientoId}/reabrir/`, {
        method: 'POST',
      });
      const estado = estadoDeRespuesta(row, 'EN_CURSO');
      const detail = await updateCachedRelevamientoState(relevamientoId, estado, row);
      return { success: true, estado, detail };
    } catch (error) {
      return { success: false, error: error?.message || 'No se pudo reabrir el relevamiento.' };
    }
  },

  async getRelevamientoDetail(id) {
    const result = await this.leerRelevamientoDetail(id);
    if (!result?.detail?.estado) return result;
    const [detail] = await normalizarEstadosFinalizando([result.detail]);
    return { ...result, detail };
  },

  async leerRelevamientoDetail(id) {
    if (!id) return { success: false, error: 'ID invalido' };

    if (isLocalId(id)) {
      const localRecords = await readLocalRecords();
      const local = localRecords.find((item) => item.local_id === id);
      if (!local) return { success: false, error: 'No se encontro el relevamiento local' };
      return {
        success: true,
        detail: {
          id: local.local_id,
          id_institucion: 1,
          created_at: local.created_at,
          sync_estado: local.sync_estado || (local.synced ? 'SINCRONIZADO' : 'PENDIENTE'),
          observaciones: local.observaciones,
          latitud: local.latitud,
          longitud: local.longitud,
          payload: local.payload || {},
          campos_extra: local.payload?.campos_extra || [],
          adjuntos: [
            ...(local.payload?.evidencias || []).map((x) => ({
              categoria: 'EVIDENCIA',
              tipo_archivo: 'IMAGEN',
              nombre_original: x?.uri?.split('/').pop() || 'evidencia.jpg',
              storage_path: x?.uri || '',
            })),
            ...(local.payload?.adjuntos || []).map((x) => ({
              categoria: 'DOCUMENTO',
              tipo_archivo: x.tipo === 'imagen' ? 'IMAGEN' : 'ARCHIVO',
              nombre_original: x.nombre || 'adjunto',
              storage_path: x.uri || '',
            })),
          ],
        },
      };
    }

    const connectivity = await getConnectivitySnapshot();
    if (!connectivity.hasInternet) {
      const cached = await readCachedRemoteRecord(id);
      if (cached?.payload?.definicion_formulario) {
        return { success: true, detail: { ...cached.payload, cached: true, offline: true } };
      }
      return { success: false, error: 'Necesitás conexión para descargar el formulario por primera vez.' };
    }

    try {
      const payload = await becasRequest(`/api/becas/relevamientos/${id}/`);
      const detail = {
        ...mapDjangoRelevamientoDetail(payload),
        cache_detail_ready: true,
      };
      await upsertCachedRemoteRecord(detail);
      return { success: true, detail };
    } catch (djangoError) {
      const status = Number(djangoError?.status || 0);
      if (status === 401 || status === 403) {
        return { success: false, error: djangoError.message || 'No autorizado' };
      }
      if (isNetworkError(djangoError)) {
        const cached = await readCachedRemoteRecord(id);
        if (cached?.payload?.definicion_formulario) {
          return { success: true, detail: { ...cached.payload, cached: true, offline: true } };
        }
        return { success: false, error: djangoError.message || 'No se pudo cargar el relevamiento asignado' };
      }
    }

    const cached = await readCachedRemoteRecord(id);
    if (cached?.payload?.definicion_formulario) {
      return { success: true, detail: { ...cached.payload, cached: true } };
    }
    return { success: false, error: 'No se pudo cargar el relevamiento desde Django.' };
  },
};

export default relevamientoService;
