// Texto del Alert que muestra la sincronización manual (ícono de nube) según el resultado de
// `retryFailedOperations`. Devuelve { title, message }.
export const resumenSyncManual = (resultado) => {
  const synced = resultado?.synced || 0;
  const failed = resultado?.failed || 0;
  const primerError = resultado?.errors?.[0]?.message;
  const waiting = resultado?.waiting || 0;
  const motivo = resultado?.waitingReason;
  const lineaEspera = waiting > 0 ? `\nEn espera: ${waiting}${motivo ? ` (${motivo})` : ''}` : '';

  if (failed > 0) {
    return {
      title: 'Sincronizacion parcial',
      message: `Sincronizados: ${synced}\nFallidos: ${failed}${primerError ? `\nDetalle: ${primerError}` : ''}${lineaEspera}`,
    };
  }
  if (synced > 0) return { title: 'Sincronizacion completa', message: `Sincronizados: ${synced}${lineaEspera}` };
  if (waiting > 0 && !resultado?.offline) {
    return {
      title: 'Sincronizacion',
      message: `Quedan ${waiting} en espera${motivo ? `: ${motivo}` : ''}. Se reintentan solas cada 5 minutos.`,
    };
  }
  if (resultado?.offline) {
    return { title: 'Sin conexion', message: 'Adjuntos pendientes. Se reintentara automaticamente al recuperar internet.' };
  }
  return { title: 'Sincronizacion', message: 'No habia elementos pendientes.' };
};
