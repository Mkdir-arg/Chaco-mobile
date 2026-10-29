// Keep cache queries and outbox transactions on one ordered queue.
// Transaction callbacks receive the raw connection so their statements do not
// queue behind the transaction that is waiting for them.
export const serializeSqliteAccess = (database) => {
  let pending = Promise.resolve();
  const enqueue = (task) => {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  };
  const connection = {};
  for (const method of ['execAsync', 'runAsync', 'getAllAsync', 'getFirstAsync']) {
    connection[method] = (...args) => enqueue(() => database[method](...args));
  }
  if (typeof database.withExclusiveTransactionAsync === 'function') {
    connection.withExclusiveTransactionAsync = (task) =>
      enqueue(() => database.withExclusiveTransactionAsync(task));
  }
  connection.withTransactionAsync = (task) =>
    enqueue(() => database.withTransactionAsync(() => task(database)));
  return connection;
};

// expo-sqlite en web (16.x) arma el pool OPFS sin candado: si las dos bases se abren a la vez,
// el worker crea dos pools sobre los mismos archivos y el segundo falla con
// NoModificationAllowedError, dejando el worker inutilizable hasta recargar. Por eso las
// aperturas van de a una: la primera inicializa el pool y las demás lo reutilizan.
let pendingOpen = Promise.resolve();
// Tras el primer choque el worker queda roto hasta recargar: las aperturas siguientes ya no
// lo llaman y devuelven el mismo aviso.
let baseOcupada = null;

export const BASE_OCUPADA = 'BASE_OCUPADA';
export const MENSAJE_BASE_OCUPADA =
  'DATAÑACH ya está abierta en otra pestaña o ventana. Cerrala y recargá esta página.';

// El mismo error aparece si otra pestaña (o la versión anterior que sigue abierta) tiene la base.
// «Invalid VFS state» es lo que contesta el worker roto a las aperturas siguientes.
export const esBaseOcupada = (error) =>
  error?.name === 'NoModificationAllowedError'
  || /createSyncAccessHandle|Access Handles cannot be created|Invalid VFS state/i.test(String(error?.message || ''));

export const openSqliteSerialized = (openDatabase, name) => {
  const result = pendingOpen.then(() => {
    if (baseOcupada) throw baseOcupada;
    return openDatabase(name);
  }).catch((error) => {
    if (error === baseOcupada) throw error;
    if (!esBaseOcupada(error)) throw error;
    baseOcupada = Object.assign(new Error(MENSAJE_BASE_OCUPADA), { code: BASE_OCUPADA, cause: error });
    throw baseOcupada;
  });
  pendingOpen = result.catch(() => {});
  return result;
};
