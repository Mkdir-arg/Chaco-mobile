// Lógica pura (sin React Native) de la pantalla «Actualizá la app», para poder probarla.

// Devuelve `{ minima, actual }` si la sesión guardada pide una versión más nueva que la
// instalada, o null para entrar normal. Si algo falla o no hay dato, no se bloquea.
export const evaluarBloqueoVersion = async ({ requiereActualizacionGuardada, versionActual, getStoredUser }) => {
  try {
    if (!(await requiereActualizacionGuardada())) return null;
    const user = await getStoredUser?.().catch(() => null);
    return { minima: user?.version_minima || null, actual: versionActual() || null };
  } catch {
    return null;
  }
};

// Solo web (PWA): busca un service worker nuevo y recarga. Es red primero para la
// navegación (scripts/build-pwa.cjs), así que con red el reload ya trae el bundle nuevo.
// Sin red no se recarga: se avisa. La regla del SW es «nunca recargar un formulario en
// captura»; acá es seguro porque esta pantalla reemplaza toda la navegación y no hay
// ningún formulario montado.
export const actualizarPWA = async ({ nav, loc }) => {
  if (nav?.onLine === false) return 'sin_conexion';
  try {
    const registro = await nav?.serviceWorker?.getRegistration?.();
    await registro?.update?.();
  } catch {
    return 'sin_conexion';
  }
  loc.reload();
  return 'recargado';
};

export const MENSAJE_SIN_CONEXION = 'Sin conexión: conectate para actualizar';
