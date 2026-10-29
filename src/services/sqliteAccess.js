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

export const BASE_OCUPADA = 'BASE_OCUPADA';
export const MENSAJE_BASE_OCUPADA =
  'DATAÑACH ya está abierta en otra pestaña o ventana. Cerrala y recargá esta página.';

// El mismo error aparece si otra pestaña (o la versión anterior que sigue abierta) tiene la base.
export const esBaseOcupada = (error) =>
  error?.name === 'NoModificationAllowedError'
  || /createSyncAccessHandle|Access Handles cannot be created/i.test(String(error?.message || ''));

export const openSqliteSerialized = (openDatabase, name) => {
  const result = pendingOpen.then(() => openDatabase(name)).catch((error) => {
    if (!esBaseOcupada(error)) throw error;
    throw Object.assign(new Error(MENSAJE_BASE_OCUPADA), { code: BASE_OCUPADA, cause: error });
  });
  pendingOpen = result.catch(() => {});
  return result;
};
