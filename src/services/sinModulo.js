// Señal común de «el back dejó de admitir este módulo». AuthContext la escucha y saca el
// módulo de la sesión local (quitarModuloLocal). Cada módulo decide cuándo avisa: Dispositivos
// ante cualquier 403 SIN_MODULO; Emergencia solo cuando el perfil también lo confirma, porque
// ahí el mismo código significa además «te falta un permiso parcial».
const listeners = new Set();

// El listener recibe el nombre del módulo y el token con el que se hizo el pedido rechazado.
export const subscribeSinModulo = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const notificarSinModulo = (modulo, tokenDelPedido) => listeners.forEach((listener) => {
  try {
    listener(modulo, tokenDelPedido ?? null);
  } catch (error) {
    console.warn('[SIN_MODULO][LISTENER]', modulo, error?.message);
  }
});

// Una página HTML de un intermediario con 403 no es la respuesta del back.
export const esSinModulo = (error) => Number(error?.status) === 403 && error?.payload?.code === 'SIN_MODULO'
  && !error?.unexpectedHtml;
