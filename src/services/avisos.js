// Avisos dentro de la app (etapa A): almacenamiento local y bandeja.
// Viven en la misma base SQLite que la cola, en tablas propias: crearlas es idempotente y
// no toca `outbox_relevamientos` ni `local_relevamientos`. Todo se guarda por dueño
// (mismo criterio que la cola) y la clave de cada aviso es UNIQUE por dueño.

export const RETENCION_MS = 30 * 24 * 60 * 60 * 1000;

const ahoraMs = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

export const crearTablasAvisos = async (db) => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS avisos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      tipo TEXT NOT NULL,
      clave TEXT NOT NULL,
      relevamiento_id TEXT,
      formulario_id TEXT,
      titulo TEXT NOT NULL,
      texto TEXT,
      creado_en TEXT NOT NULL,
      leido_en TEXT,
      UNIQUE (owner, clave)
    );
    CREATE TABLE IF NOT EXISTS avisos_relevamientos_vistos (
      owner TEXT NOT NULL,
      relevamiento_id TEXT NOT NULL,
      fecha_hasta TEXT,
      numero TEXT,
      seguido INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (owner, relevamiento_id)
    );
    CREATE TABLE IF NOT EXISTS avisos_rechazos_conocidos (
      owner TEXT NOT NULL,
      formulario_id TEXT NOT NULL,
      relevamiento_id TEXT,
      PRIMARY KEY (owner, formulario_id)
    );
    CREATE TABLE IF NOT EXISTS avisos_purgados (
      owner TEXT NOT NULL,
      clave TEXT NOT NULL,
      PRIMARY KEY (owner, clave)
    );
    CREATE TABLE IF NOT EXISTS avisos_estado (
      owner TEXT NOT NULL,
      clave TEXT NOT NULL,
      valor TEXT,
      PRIMARY KEY (owner, clave)
    );
  `);
};

export const leerEstado = async (db, owner, clave) => {
  const fila = await db.getFirstAsync('SELECT valor FROM avisos_estado WHERE owner = ? AND clave = ?', owner, clave);
  return fila?.valor ?? null;
};

export const guardarEstado = async (db, owner, clave, valor) => {
  await db.runAsync(
    `INSERT INTO avisos_estado (owner, clave, valor) VALUES (?, ?, ?)
     ON CONFLICT(owner, clave) DO UPDATE SET valor = excluded.valor`,
    owner, clave, String(valor)
  );
};

// Inserta un aviso. Si la clave ya existe para ese dueño no hace nada y devuelve false.
export const crearAviso = async (db, owner, aviso, ahora = ahoraMs()) => {
  if (!owner || !aviso?.clave) return false;
  const resultado = await db.runAsync(
    // Un aviso ya purgado por antigüedad no vuelve a crearse (queda su clave sin datos).
    `INSERT OR IGNORE INTO avisos (owner, tipo, clave, relevamiento_id, formulario_id, titulo, texto, creado_en)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM avisos_purgados WHERE owner = ? AND clave = ?)`,
    String(owner), aviso.tipo, aviso.clave,
    aviso.relevamiento_id == null ? null : String(aviso.relevamiento_id),
    aviso.formulario_id == null ? null : String(aviso.formulario_id),
    aviso.titulo, aviso.texto || '', iso(ahora),
    String(owner), aviso.clave
  );
  return Number(resultado?.changes || 0) > 0;
};

export const listarAvisos = async (db, owner, { limite = 100 } = {}) => {
  if (!owner) return [];
  return db.getAllAsync(
    'SELECT * FROM avisos WHERE owner = ? ORDER BY creado_en DESC, id DESC LIMIT ?',
    String(owner), limite
  );
};

export const contarNoLeidos = async (db, owner) => {
  if (!owner) return 0;
  const fila = await db.getFirstAsync(
    'SELECT COUNT(*) AS total FROM avisos WHERE owner = ? AND leido_en IS NULL', String(owner)
  );
  return Number(fila?.total || 0);
};

export const marcarLeido = async (db, owner, id, ahora = ahoraMs()) => {
  if (!owner) return;
  await db.runAsync(
    'UPDATE avisos SET leido_en = ? WHERE owner = ? AND id = ? AND leido_en IS NULL', iso(ahora), String(owner), id
  );
};

export const marcarTodoLeido = async (db, owner, ahora = ahoraMs()) => {
  if (!owner) return;
  await db.runAsync('UPDATE avisos SET leido_en = ? WHERE owner = ? AND leido_en IS NULL', iso(ahora), String(owner));
};

// Menos datos personales en el teléfono: los avisos con más de 30 días se borran, leídos
// o no y de todos los dueños (no solo el de la sesión). Queda la clave, sin datos, para que
// el mismo hecho no reaparezca como aviso nuevo.
export const purgarAvisosViejos = async (db, ahora = ahoraMs()) => {
  const limite = iso(ahora - RETENCION_MS);
  await db.runAsync(
    'INSERT OR IGNORE INTO avisos_purgados (owner, clave) SELECT owner, clave FROM avisos WHERE creado_en < ?', limite
  );
  await db.runAsync('DELETE FROM avisos WHERE creado_en < ?', limite);
};

export const haceCuanto = (creadoEn, ahora = ahoraMs()) => {
  const ms = ahora - Date.parse(creadoEn);
  if (!Number.isFinite(ms) || ms < 60 * 1000) return 'hace un momento';
  const minutos = Math.floor(ms / 60000);
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  return `hace ${dias} ${dias === 1 ? 'día' : 'días'}`;
};
