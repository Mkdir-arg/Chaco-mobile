import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { getBecasToken, getStoredBecasUser } from './becasApi';
import { enviarCaso, esUuidEnUso, getLocalidades, getMisCasos, relevadoEnIso } from './emergenciaApi';
import { openSqliteSerialized, serializeSqliteAccess } from './sqliteAccess';
import { esSinModulo } from './sinModulo';
import { persistWebAttachment } from './webAttachments';
import { liberarJpeg } from '../utils/jpeg';
import {
  datosDelCaso, datosIniciales, erroresDelServidor, FOTOS, hayErrores, resumenDeFamilia, validarCaso,
} from '../utils/emergencia';

// M1 · Ingreso de familias: borradores, cola de envíos sin señal y cachés (localidades y «Mis
// envíos») del módulo Emergencia. Base, tablas y carpeta de fotos propias: no toca las de Becas ni
// las de Dispositivos. Contrato: contrato-app-emergencia §5 a §7.
//
// Un caso vive primero como borrador (con su `uuid_cliente`, que nace con él) y al tocar «Enviar»
// pasa a la cola con el MISMO uuid, que se conserva en todos los reintentos. Un 400 lo devuelve a
// borrador, otra vez con el mismo uuid y con los errores por campo para corregir.
const SQLITE_DB_NAME = 'emergencia_offline.db';
const TABLA_BORRADORES = 'borradores_casos';
const TABLA_OUTBOX = 'outbox_casos';
const TABLA_LOCALIDADES = 'cache_localidades';
const TABLA_MIS_CASOS = 'cache_mis_casos';
const ATTACHMENTS_DIR = `${FileSystem.documentDirectory}attachments/emergencia`;
export const MAX_RETRY_COUNT = 8;
export const MAX_FOTO_BYTES = 5 * 1024 * 1024;
// Un envío con dos fotos por una red mala tarda: el pedido se corta a los 90 s y una IN_FLIGHT se
// da por abandonada (proceso muerto, otra pestaña) recién a los 2 minutos.
const ENVIO_TIMEOUT_MS = 90 * 1000;
const OUTBOX_IN_FLIGHT_TIMEOUT_MS = 2 * 60 * 1000;
const PAUSED_RETRY_MS = 5 * 60 * 1000;
const ESPERA_ENVIO_MS = 1500;
export const LOCALIDADES_VIGENCIA_MS = 24 * 60 * 60 * 1000;
// Lo ya entregado o descartado se guarda una semana (solo la fila, sin fotos) y después se poda.
const RETENCION_MS = 7 * 24 * 60 * 60 * 1000;

export const ERROR_ARCHIVO_LOCAL_FALTANTE = 'ARCHIVO_LOCAL_FALTANTE';
export const ERROR_VALIDACION_LOCAL = 'VALIDACION_LOCAL';
export const ERROR_FOTO_INVALIDA = 'FOTO_INVALIDA';

let sqliteDbPromise = null;
let sqliteInitPromise = null;
let syncInFlightPromise = null;

const nowIso = () => new Date().toISOString();
const createUuid = () => String(Crypto.randomUUID()).toLowerCase();
const createError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const safeParse = (value, fallback = null) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const getCurrentOwnerId = async () => {
  const user = await getStoredBecasUser();
  return user?.id == null ? '' : String(user.id);
};
const exigirOwner = async () => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) throw createError('SIN_SESION', 'No hay sesión iniciada.');
  return ownerId;
};
export const calculateBackoffMs = (retryCount = 0) => Math.min(5 * 60 * 1000, 2500 * (2 ** Math.max(0, retryCount)));

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
    `UPDATE ${TABLA_OUTBOX} SET status = 'PENDING', started_at = NULL, updated_at = ?
     WHERE status = 'IN_FLIGHT' AND (started_at IS NULL OR started_at <= ?)`,
    nowIso(), threshold);
};

const podarViejos = async (db) => {
  const limite = new Date(Date.now() - RETENCION_MS).toISOString();
  await db.runAsync(
    `DELETE FROM ${TABLA_OUTBOX} WHERE status IN ('DONE', 'DISCARDED') AND updated_at <= ?`, limite);
};

const ensureSqliteReady = async () => {
  if (!sqliteInitPromise) {
    sqliteInitPromise = (async () => {
      const db = await getSqliteDb();
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS ${TABLA_BORRADORES} (
          uuid_cliente TEXT PRIMARY KEY NOT NULL,
          owner_user_id TEXT NOT NULL,
          datos_json TEXT NOT NULL,
          fotos_json TEXT NOT NULL DEFAULT '{}',
          errores_json TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_${TABLA_BORRADORES}_owner
        ON ${TABLA_BORRADORES} (owner_user_id, updated_at);
        CREATE TABLE IF NOT EXISTS ${TABLA_OUTBOX} (
          op_id TEXT PRIMARY KEY NOT NULL,
          owner_user_id TEXT NOT NULL,
          uuid_cliente TEXT NOT NULL UNIQUE,
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
          resultado_json TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_${TABLA_OUTBOX}_owner_status
        ON ${TABLA_OUTBOX} (owner_user_id, status, created_at);
        CREATE TABLE IF NOT EXISTS ${TABLA_LOCALIDADES} (
          clave TEXT PRIMARY KEY NOT NULL,
          data_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${TABLA_MIS_CASOS} (
          owner_user_id TEXT PRIMARY KEY NOT NULL,
          data_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      await recoverStaleInFlightOperations(db);
      await podarViejos(db);
    })().catch((error) => {
      sqliteInitPromise = null;
      throw error;
    });
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

// ---- Fotos ----

const CAMPOS_FOTO = FOTOS.map(({ clave }) => clave);
const sanitizeFileName = (value = 'foto.jpg') =>
  String(value).replace(/[^\w.-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'foto.jpg';
const isPersistentUri = (uri = '') => String(uri).startsWith(ATTACHMENTS_DIR);

const borrarUri = async (uri) => {
  try {
    if (typeof FileSystem.deleteAsync === 'function') await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Un archivo que no se pudo borrar no cambia nada para el agente.
  }
};
const borrarArchivo = async (item) => {
  if (Platform.OS === 'web' || !isPersistentUri(item?.uri)) return;
  await borrarUri(item.uri);
};
const borrarFotos = async (fotos = {}) => {
  for (const item of Object.values(fotos || {})) await borrarArchivo(item);
};

// La foto ya convertida con aJpeg → copia estable: en web una data URL (sobrevive a recargar y se
// guarda en la base, OPFS), en nativo un archivo en la carpeta propia de Emergencia.
const persistirFoto = async (asset, { temporal = false } = {}) => {
  if (!asset?.uri) throw createError(ERROR_ARCHIVO_LOCAL_FALTANTE, 'Falta la foto.');
  const fileName = sanitizeFileName(asset.fileName || asset.name || 'foto.jpg');
  const size = Number(asset.fileSize ?? asset.size ?? 0) || null;
  if (asset.mimeType && asset.mimeType !== 'image/jpeg') {
    throw createError(ERROR_FOTO_INVALIDA, 'La foto tiene que estar en JPEG.');
  }
  if (size != null && size > MAX_FOTO_BYTES) throw createError(ERROR_FOTO_INVALIDA, 'La foto pasa de 5 MB.');
  if (Platform.OS === 'web') {
    const persisted = await persistWebAttachment({ uri: asset.uri, mimeType: 'image/jpeg', size });
    return { uri: persisted.uri, fileName, mimeType: 'image/jpeg', size: persisted.size ?? size };
  }
  if (isPersistentUri(asset.uri)) return { uri: asset.uri, fileName, mimeType: 'image/jpeg', size };
  const dir = await FileSystem.getInfoAsync(ATTACHMENTS_DIR);
  if (!dir.exists) await FileSystem.makeDirectoryAsync(ATTACHMENTS_DIR, { intermediates: true });
  const destino = `${ATTACHMENTS_DIR}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${fileName}`;
  await FileSystem.copyAsync({ from: asset.uri, to: destino });
  const info = await FileSystem.getInfoAsync(destino, { size: true });
  // La salida de aJpeg queda en la caché: ya copiada, se borra.
  if (temporal) await borrarUri(asset.uri);
  return { uri: destino, fileName, mimeType: 'image/jpeg', size: info?.size ?? size };
};

const fotosQueFaltan = async (fotos = {}) => {
  if (Platform.OS === 'web') return [];
  const faltan = [];
  for (const [campo, item] of Object.entries(fotos || {})) {
    if (!item?.uri || String(item.uri).startsWith('content://')) continue;
    try {
      const info = await FileSystem.getInfoAsync(item.uri);
      if (!info?.exists) faltan.push(campo);
    } catch {
      faltan.push(campo);
    }
  }
  return faltan;
};

// ---- Borradores ----

const mapBorrador = (row) => row && ({
  tipo: 'borrador',
  uuid_cliente: row.uuid_cliente,
  datos: { ...datosIniciales(), ...safeParse(row.datos_json, {}) },
  fotos: safeParse(row.fotos_json, {}) || {},
  errores: safeParse(row.errores_json, null),
  code: row.error_code || null,
  creado_en: row.created_at,
  actualizado_en: row.updated_at,
});

const leerBorrador = async (ownerId, uuid) => {
  const db = await withDb();
  return mapBorrador(await db.getFirstAsync(
    `SELECT * FROM ${TABLA_BORRADORES} WHERE owner_user_id = ? AND uuid_cliente = ?`, ownerId, String(uuid)));
};

// Con `uuid`, ese borrador (el que volvió con errores) o null. Sin `uuid`, el que se estaba
// cargando (sin errores); si no hay, uno nuevo: el `uuid_cliente` nace acá y ya no cambia.
export const abrirBorrador = async ({ uuid = null } = {}) => {
  const ownerId = await exigirOwner();
  if (uuid) return leerBorrador(ownerId, uuid);
  const db = await withDb();
  const enCurso = await db.getFirstAsync(
    `SELECT * FROM ${TABLA_BORRADORES} WHERE owner_user_id = ? AND errores_json IS NULL
     ORDER BY updated_at DESC, rowid DESC LIMIT 1`, ownerId);
  if (enCurso) return mapBorrador(enCurso);
  const stamp = nowIso();
  const nuevo = createUuid();
  await db.runAsync(
    `INSERT INTO ${TABLA_BORRADORES} (uuid_cliente, owner_user_id, datos_json, fotos_json, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`, nuevo, ownerId, JSON.stringify(datosIniciales()), stamp, stamp);
  return { ...(await leerBorrador(ownerId, nuevo)), nuevo: true };
};

// Autoguardado de la pantalla. Los errores del servidor se quedan hasta el próximo envío.
export const guardarBorrador = async (uuid, datos) => {
  const ownerId = await exigirOwner();
  const db = await withDb();
  const result = await db.runAsync(
    `UPDATE ${TABLA_BORRADORES} SET datos_json = ?, updated_at = ? WHERE owner_user_id = ? AND uuid_cliente = ?`,
    JSON.stringify(datos || {}), nowIso(), ownerId, String(uuid));
  return Number(result?.changes || 0) > 0;
};

// `asset` es la salida de aJpeg. `temporal`: en nativo, la salida es un archivo de la caché que
// aJpeg creó (no la foto original del selector) y se borra una vez copiado. En web se libera la
// blob: URL de aJpeg apenas se guardó la data URL.
export const ponerFoto = async (uuid, campo, asset, { temporal = false } = {}) => {
  if (!CAMPOS_FOTO.includes(campo)) throw createError(ERROR_FOTO_INVALIDA, 'Esa foto no es del formulario.');
  const ownerId = await exigirOwner();
  let item;
  try {
    const borrador = await leerBorrador(ownerId, uuid);
    if (!borrador) throw createError('SIN_BORRADOR', 'El borrador ya no existe.');
    item = await persistirFoto(asset, { temporal });
    const anterior = borrador.fotos[campo];
    const fotos = { ...borrador.fotos, [campo]: item };
    const db = await withDb();
    await db.runAsync(
      `UPDATE ${TABLA_BORRADORES} SET fotos_json = ?, updated_at = ? WHERE owner_user_id = ? AND uuid_cliente = ?`,
      JSON.stringify(fotos), nowIso(), ownerId, String(uuid));
    if (anterior?.uri && anterior.uri !== item.uri) await borrarArchivo(anterior);
    return item;
  } catch (error) {
    if (item) await borrarArchivo(item);
    throw error;
  } finally {
    liberarJpeg(asset);
  }
};

export const quitarFoto = async (uuid, campo) => {
  const ownerId = await exigirOwner();
  const borrador = await leerBorrador(ownerId, uuid);
  if (!borrador?.fotos?.[campo]) return false;
  const { [campo]: quitada, ...fotos } = borrador.fotos;
  const db = await withDb();
  await db.runAsync(
    `UPDATE ${TABLA_BORRADORES} SET fotos_json = ?, updated_at = ? WHERE owner_user_id = ? AND uuid_cliente = ?`,
    JSON.stringify(fotos), nowIso(), ownerId, String(uuid));
  await borrarArchivo(quitada);
  return true;
};

export const descartarBorrador = async (uuid) => {
  const ownerId = await exigirOwner();
  const borrador = await leerBorrador(ownerId, uuid);
  if (!borrador) return false;
  const db = await withDb();
  await db.runAsync(`DELETE FROM ${TABLA_BORRADORES} WHERE owner_user_id = ? AND uuid_cliente = ?`, ownerId, String(uuid));
  await borrarFotos(borrador.fotos);
  return true;
};

// ---- Cola ----

const mapOutboxRow = (row = {}) => ({
  op_id: row.op_id,
  owner_user_id: row.owner_user_id,
  uuid_cliente: row.uuid_cliente,
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
  resultado: safeParse(row.resultado_json, null),
});

const ESTADO_ENVIO = { PENDING: 'pendiente', IN_FLIGHT: 'enviando', FAILED_PERMANENT: 'error', DONE: 'enviado', DISCARDED: 'descartado' };

const mapEnvio = (op) => op && ({
  tipo: 'envio',
  op_id: op.op_id,
  uuid_cliente: op.uuid_cliente,
  status: op.status,
  estado: ESTADO_ENVIO[op.status] || 'pendiente',
  code: op.last_error_code,
  detail: op.last_error_info?.detail ?? op.last_error,
  errores: null,
  datos: op.payload?.formulario || {},
  resumen: resumenDeFamilia(op.payload?.formulario || {}),
  relevado_en: op.payload?.datos?.relevado_en ?? null,
  resultado: op.resultado,
  retry_count: op.retry_count,
  next_retry_at: op.next_retry_at,
  creado_en: op.created_at,
  puedeReintentar: op.status === 'FAILED_PERMANENT' && op.last_error_code !== 'UUID_EN_USO',
  puedeDescartar: ['PENDING', 'FAILED_PERMANENT'].includes(op.status),
});

const readOperations = async (ownerId, where = '1 = 1', ...args) => {
  const db = await withDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM ${TABLA_OUTBOX} WHERE owner_user_id = ? AND ${where} ORDER BY created_at ASC, rowid ASC`,
    ownerId, ...args);
  return rows.map(mapOutboxRow);
};

export const getEnvio = async (uuid) => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return null;
  const [op] = await readOperations(ownerId, 'uuid_cliente = ?', String(uuid));
  if (op) return mapEnvio(op);
  const borrador = await leerBorrador(ownerId, uuid);
  return borrador && hayErrores(borrador.errores) ? { ...borrador, estado: 'corregir', resumen: resumenDeFamilia(borrador.datos) } : null;
};

// Lo que todavía está en el teléfono sin entregar, lo más nuevo primero: envíos en cola o con
// error y borradores que el servidor devolvió para corregir.
export const getEnviosLocales = async () => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return [];
  const db = await withDb();
  const ops = (await readOperations(ownerId, "status IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')")).map(mapEnvio);
  const borradores = (await db.getAllAsync(
    `SELECT * FROM ${TABLA_BORRADORES} WHERE owner_user_id = ? AND errores_json IS NOT NULL`, ownerId))
    .map(mapBorrador)
    .map((b) => ({ ...b, estado: 'corregir', resumen: resumenDeFamilia(b.datos), puedeDescartar: true, puedeReintentar: false }));
  return [...ops, ...borradores].sort((a, b) => String(b.creado_en).localeCompare(String(a.creado_en)));
};

// Lo que guarda datos de una familia sin entregar: el badge del Banner y el aviso al salir.
export const getPendingCount = async () => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return 0;
  const db = await withDb();
  const ops = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM ${TABLA_OUTBOX}
     WHERE owner_user_id = ? AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED_PERMANENT')`, ownerId);
  const borradores = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM ${TABLA_BORRADORES} WHERE owner_user_id = ? AND errores_json IS NOT NULL`, ownerId);
  return Number(ops?.count || 0) + Number(borradores?.count || 0);
};

const esperarHasta = async (promesa, ms) => {
  let timer;
  const tope = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([promesa, tope]);
  } finally {
    clearTimeout(timer);
  }
};

// «Enviar»: el borrador pasa a la cola con su mismo uuid y la hora de este momento
// (`relevado_en`, §6). `datos` es lo último de la pantalla (si no viene, lo guardado). Valida lo
// que el cliente puede validar; lo demás lo dice el back. Con `sincronizar`, intenta enviarlo ya y
// espera un momento para poder decir si salió.
export const encolarCaso = async (uuid, { datos = null, relevadoEn = new Date() } = {}, { sincronizar = true } = {}) => {
  const ownerId = await exigirOwner();
  const borrador = await leerBorrador(ownerId, uuid);
  if (!borrador) throw createError('SIN_BORRADOR', 'Este relevamiento ya no está en el teléfono.');
  const formulario = { ...borrador.datos, ...(datos || {}) };
  const errores = validarCaso(formulario);
  if (hayErrores(errores)) throw createError(ERROR_VALIDACION_LOCAL, 'Hay datos para corregir.', { errores });
  const [previa] = await readOperations(ownerId, 'uuid_cliente = ?', String(uuid));
  if (previa && previa.status !== 'DISCARDED') throw createError('YA_EN_COLA', 'Este relevamiento ya se envió o está en la cola.');

  const stamp = nowIso();
  const opId = `emerg_${createUuid()}`;
  const payload = {
    _owner_user_id: ownerId,
    modulo: 'emergencia',
    uuid_cliente: borrador.uuid_cliente,
    datos: { ...datosDelCaso(formulario), uuid_cliente: borrador.uuid_cliente, relevado_en: relevadoEnIso(relevadoEn) },
    fotos: borrador.fotos || {},
    formulario,
    capturado_en: stamp,
  };
  const db = await withDb();
  await runSqliteTx(db, async (tx) => {
    if (previa) await tx.runAsync(`DELETE FROM ${TABLA_OUTBOX} WHERE op_id = ?`, previa.op_id);
    await tx.runAsync(
      `INSERT INTO ${TABLA_OUTBOX} (op_id, owner_user_id, uuid_cliente, status, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`,
      opId, ownerId, borrador.uuid_cliente, JSON.stringify(payload), stamp, stamp);
    await tx.runAsync(`DELETE FROM ${TABLA_BORRADORES} WHERE owner_user_id = ? AND uuid_cliente = ?`, ownerId, borrador.uuid_cliente);
  });

  const syncResult = sincronizar
    ? await esperarHasta(syncPendientes().catch(() => null), ESPERA_ENVIO_MS)
    : null;
  return { op_id: opId, uuid_cliente: borrador.uuid_cliente, envio: await getEnvio(borrador.uuid_cliente), syncResult };
};

const marcarEnVuelo = async (opId) => {
  const db = await withDb();
  const stamp = nowIso();
  const result = await db.runAsync(
    `UPDATE ${TABLA_OUTBOX} SET status = 'IN_FLIGHT', started_at = ?, updated_at = ?
     WHERE op_id = ? AND status = 'PENDING'`, stamp, stamp, opId);
  return Number(result?.changes || 0) > 0;
};

const cerrarOperacion = async (opId, { status, retryCount = 0, nextRetryAt = null, info = null, resultado = null }) => {
  const db = await withDb();
  const stamp = nowIso();
  const done = status === 'DONE';
  await db.runAsync(
    `UPDATE ${TABLA_OUTBOX}
     SET status = ?, started_at = NULL, ack_at = ?, retry_count = ?, next_retry_at = ?,
         last_error = ?, last_error_code = ?, last_error_json = ?, resultado_json = ?, updated_at = ?
     WHERE op_id = ?`,
    status, done ? stamp : null, retryCount, nextRetryAt,
    done ? null : info?.message ?? null, done ? null : info?.code ?? null,
    done || !info ? null : JSON.stringify(info), resultado ? JSON.stringify(resultado) : null, stamp, opId);
};

// El envío vuelve a borrador, con el mismo uuid, las mismas fotos y los errores por campo.
const volverABorrador = async (operation, errores, code) => {
  const db = await withDb();
  const stamp = nowIso();
  const { payload } = operation;
  await runSqliteTx(db, async (tx) => {
    await tx.runAsync(
      `INSERT OR REPLACE INTO ${TABLA_BORRADORES}
       (uuid_cliente, owner_user_id, datos_json, fotos_json, errores_json, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      operation.uuid_cliente, operation.owner_user_id, JSON.stringify(payload.formulario || {}),
      JSON.stringify(payload.fotos || {}), JSON.stringify(errores), code, operation.created_at, stamp);
    await tx.runAsync(`DELETE FROM ${TABLA_OUTBOX} WHERE op_id = ?`, operation.op_id);
  });
};

const esFallaTransitoria = (error) => {
  const status = Number(error?.status || 0);
  return error?.network === true || error?.unexpectedHtml === true || !status
    || status >= 500 || status === 408 || status === 429 || (status === 403 && !error?.payload?.code);
};

// Solo por status y `payload.code`; nunca por el texto del mensaje.
export const clasificarError = (error) => {
  const status = Number(error?.status || 0);
  const payload = error?.payload && typeof error.payload === 'object' ? error.payload : null;
  const code = payload?.code || error?.code || null;
  const info = { status, code, message: error?.message || 'Error desconocido', detail: payload?.detail ?? null };
  if (error?.code === 'FECHA_INVALIDA' && error?.campo) {
    return { accion: 'borrador', errores: { [error.campo]: [error.message] }, info: { ...info, code: 'VALIDACION' } };
  }
  if (status === 401) return { accion: 'sesion', info: { ...info, code: 'AUTH_REQUIRED' } };
  if (esSinModulo(error)) return { accion: 'sin_modulo', info: { ...info, code: 'SIN_MODULO', verificacion: error?.verificacionSinModulo ?? null } };
  if (esUuidEnUso(error)) return { accion: 'permanente', info: { ...info, code: 'UUID_EN_USO' } };
  if (status === 400 && !error?.unexpectedHtml) {
    return { accion: 'borrador', errores: erroresDelServidor(payload), info: { ...info, code: 'VALIDACION' } };
  }
  if (status === 429) return { accion: 'espera', espera: error?.retryAfter ?? PAUSED_RETRY_MS, info: { ...info, code: 'RATE_LIMITED' } };
  if (esFallaTransitoria(error)) return { accion: 'reintento', espera: error?.retryAfter ?? null, info };
  return { accion: 'permanente', info: { ...info, code: code || 'RECHAZADA' } };
};

const aplicarFalla = async (operation, error) => {
  const clasificado = clasificarError(error);
  const { accion, info } = clasificado;
  const retryCount = operation.retry_count || 0;
  const en = (ms) => new Date(Date.now() + ms).toISOString();
  if (accion === 'sesion') {
    await cerrarOperacion(operation.op_id, { status: 'PENDING', retryCount, info });
  } else if (accion === 'sin_modulo') {
    // El contrato dice no reintentar: queda guardado, a la vista, hasta que el agente lo reintente.
    await cerrarOperacion(operation.op_id, { status: 'FAILED_PERMANENT', retryCount, info });
  } else if (accion === 'espera') {
    await cerrarOperacion(operation.op_id, { status: 'PENDING', retryCount, info, nextRetryAt: en(clasificado.espera) });
  } else if (accion === 'reintento') {
    const proximo = retryCount + 1;
    if (proximo > MAX_RETRY_COUNT) {
      await cerrarOperacion(operation.op_id, {
        status: 'FAILED_PERMANENT', retryCount: proximo, info: { ...info, code: 'REINTENTOS_AGOTADOS' },
      });
    } else {
      const espera = Math.max(calculateBackoffMs(proximo), clasificado.espera || 0);
      await cerrarOperacion(operation.op_id, { status: 'PENDING', retryCount: proximo, info, nextRetryAt: en(espera) });
    }
  } else if (accion === 'borrador') {
    await volverABorrador(operation, hayErrores(clasificado.errores)
      ? clasificado.errores : { non_field_errors: [info.detail || info.message] }, info.code);
  } else {
    await cerrarOperacion(operation.op_id, { status: 'FAILED_PERMANENT', retryCount, info });
  }
  return clasificado;
};

const ejecutarOperacion = async (operation) => {
  const { payload } = operation;
  const faltan = await fotosQueFaltan(payload.fotos);
  if (faltan.length) {
    const errores = Object.fromEntries(faltan.map((campo) => [campo, ['La foto ya no está en el teléfono: volvé a sacarla.']]));
    throw createError(ERROR_ARCHIVO_LOCAL_FALTANTE, 'Falta una foto en el teléfono.', { errores });
  }
  return enviarCaso(payload.datos, payload.fotos, { timeoutMs: ENVIO_TIMEOUT_MS });
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
      return { synced: 0, failed: 0, skipped: queue.length, offline: true, errors: [{ message: 'Sin conexión' }] };
    }
    let synced = 0;
    let failed = 0;
    const errors = [];
    const ahora = Date.now();
    for (const operation of queue) {
      if (!await getBecasToken()) break;
      const proximo = operation.next_retry_at ? Date.parse(operation.next_retry_at) : null;
      if (proximo && Number.isFinite(proximo) && proximo > ahora) continue;
      if (!await marcarEnVuelo(operation.op_id)) continue;
      try {
        const resultado = await ejecutarOperacion(operation);
        await cerrarOperacion(operation.op_id, { status: 'DONE', resultado: resultado && typeof resultado === 'object' ? resultado : null });
        await borrarFotos(operation.payload.fotos);
        synced += 1;
      } catch (error) {
        failed += 1;
        if (error?.code === ERROR_ARCHIVO_LOCAL_FALTANTE) {
          await volverABorrador(operation, error.errores, ERROR_ARCHIVO_LOCAL_FALTANTE);
          errors.push({ op_id: operation.op_id, message: error.message, code: ERROR_ARCHIVO_LOCAL_FALTANTE });
          continue;
        }
        const { accion, info } = await aplicarFalla(operation, error);
        errors.push({ op_id: operation.op_id, message: info.message, code: info.code });
        // Sesión o permiso: vale para todo lo que sigue en la cola, se corta la pasada.
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

// El agente pide reintentar uno (`uuid`) o todos los que quedaron con error. Nunca un 409
// UUID_EN_USO: ese identificador no se vuelve a usar.
export const reintentar = async (uuid = null) => {
  const ownerId = await getCurrentOwnerId();
  if (!ownerId) return { synced: 0, failed: 0, errors: [] };
  if (syncInFlightPromise) await syncInFlightPromise;
  const db = await withDb();
  await db.runAsync(
    `UPDATE ${TABLA_OUTBOX}
     SET status = 'PENDING', retry_count = 0, next_retry_at = NULL, started_at = NULL, updated_at = ?
     WHERE owner_user_id = ? AND status = 'FAILED_PERMANENT'
       AND (last_error_code IS NULL OR last_error_code <> 'UUID_EN_USO')
       ${uuid == null ? '' : 'AND uuid_cliente = ?'}`,
    nowIso(), ownerId, ...(uuid == null ? [] : [String(uuid)]));
  // También los que esperan su backoff: el agente pidió enviar ahora.
  await db.runAsync(
    `UPDATE ${TABLA_OUTBOX} SET next_retry_at = NULL, updated_at = ?
     WHERE owner_user_id = ? AND status = 'PENDING' ${uuid == null ? '' : 'AND uuid_cliente = ?'}
       AND (last_error_code IS NULL OR last_error_code <> 'RATE_LIMITED')`,
    nowIso(), ownerId, ...(uuid == null ? [] : [String(uuid)]));
  return syncPendientes();
};

// El agente suelta un envío que no salió (en cola o con error) o un borrador devuelto: se borran
// las fotos; del envío queda la fila marcada DISCARDED hasta la poda. Uno que se está enviando no se toca.
export const descartar = async (uuid) => {
  const ownerId = await exigirOwner();
  const db = await withDb();
  const [op] = await readOperations(ownerId, "uuid_cliente = ? AND status IN ('PENDING', 'FAILED_PERMANENT')", String(uuid));
  if (op) {
    const result = await db.runAsync(
      `UPDATE ${TABLA_OUTBOX} SET status = 'DISCARDED', payload_json = ?, next_retry_at = NULL, updated_at = ?
       WHERE op_id = ? AND status IN ('PENDING', 'FAILED_PERMANENT')`,
      JSON.stringify({ ...op.payload, fotos: {} }), nowIso(), op.op_id);
    if (!Number(result?.changes || 0)) return false;
    await borrarFotos(op.payload.fotos);
    return true;
  }
  return descartarBorrador(uuid);
};

// ---- Localidades (§5): la lista entera, guardada y refrescada una vez por día ----

const leerLocalidades = async () => {
  const db = await withDb();
  const row = await db.getFirstAsync(`SELECT * FROM ${TABLA_LOCALIDADES} WHERE clave = 'todas'`);
  return row ? { localidades: safeParse(row.data_json, []) || [], actualizadas_en: row.updated_at } : null;
};

const normalizarLocalidades = (lista) => (Array.isArray(lista) ? lista : [])
  .filter((item) => item && item.id != null && typeof item.nombre === 'string')
  .map(({ id, nombre }) => ({ id, nombre }));

// Devuelve { localidades, actualizadas_en, desdeCache }. Pide al back solo si la guardada tiene
// más de un día (o `forzar`) y hay red; si el pedido falla, sigue con la guardada. Sin ninguna
// guardada y sin poder pedirla, devuelve la lista vacía: la localidad es opcional.
export const getLocalidadesGuardadas = async ({ forzar = false } = {}) => {
  const guardada = await leerLocalidades();
  const edad = guardada ? Date.now() - Date.parse(guardada.actualizadas_en) : Infinity;
  const vigente = Number.isFinite(edad) && edad >= 0 && edad < LOCALIDADES_VIGENCIA_MS;
  if ((forzar || !vigente) && await getConnectivitySnapshot()) {
    try {
      const localidades = normalizarLocalidades(await getLocalidades());
      const stamp = nowIso();
      const db = await withDb();
      await db.runAsync(
        `INSERT OR REPLACE INTO ${TABLA_LOCALIDADES} (clave, data_json, updated_at) VALUES ('todas', ?, ?)`,
        JSON.stringify(localidades), stamp);
      return { localidades, actualizadas_en: stamp, desdeCache: false };
    } catch (error) {
      if (Number(error?.status) === 401) throw error;
    }
  }
  return guardada ? { ...guardada, desdeCache: true } : { localidades: [], actualizadas_en: null, desdeCache: true };
};

// ---- «Mis envíos» (§7): lo que ya llegó al servidor, con copia para verlo sin red ----

export const getMisEnvios = async () => {
  const ownerId = await exigirOwner();
  const db = await withDb();
  const leerGuardado = async () => {
    const row = await db.getFirstAsync(`SELECT * FROM ${TABLA_MIS_CASOS} WHERE owner_user_id = ?`, ownerId);
    return row ? { casos: safeParse(row.data_json, []) || [], actualizado_en: row.updated_at } : null;
  };
  if (await getConnectivitySnapshot()) {
    try {
      const respuesta = await getMisCasos();
      const casos = Array.isArray(respuesta) ? respuesta : (respuesta?.results || []);
      const stamp = nowIso();
      await db.runAsync(
        `INSERT OR REPLACE INTO ${TABLA_MIS_CASOS} (owner_user_id, data_json, updated_at) VALUES (?, ?, ?)`,
        ownerId, JSON.stringify(casos), stamp);
      return { casos, actualizado_en: stamp, desdeCache: false, sinRed: false };
    } catch (error) {
      if (Number(error?.status) === 401) throw error;
      const guardado = await leerGuardado();
      if (!guardado) throw error;
      return { ...guardado, desdeCache: true, sinRed: !!error?.network, error };
    }
  }
  const guardado = await leerGuardado();
  return { ...(guardado || { casos: [], actualizado_en: null }), desdeCache: true, sinRed: true };
};

export default {
  abrirBorrador,
  guardarBorrador,
  ponerFoto,
  quitarFoto,
  descartarBorrador,
  encolarCaso,
  syncPendientes,
  reintentar,
  descartar,
  getEnvio,
  getEnviosLocales,
  getPendingCount,
  getLocalidadesGuardadas,
  getMisEnvios,
};
