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
