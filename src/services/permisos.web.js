// Permisos del dispositivo (variante web/PWA). El estado sale de navigator.permissions;
// donde esa API no existe (Safari) el estado es 'unknown' y el boton "Permitir" queda igual.
export const PERMISOS = ['ubicacion', 'camara'];
export const ETIQUETAS_ESTADO = {
  granted: 'Permitido',
  prompt: 'Sin pedir',
  denied: 'Bloqueado',
  unknown: 'No se puede saber',
};

const NOMBRE_API = { ubicacion: 'geolocation', camara: 'camera' };
const ESPERA_UBICACION_MS = 15000;

export const estadoDesdeApi = (state) => (
  state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown'
);

const resultado = (estado) => ({ estado, canAskAgain: estado !== 'denied' });

export async function consultarPermiso(clave) {
  try {
    const status = await navigator.permissions.query({ name: NOMBRE_API[clave] });
    return resultado(estadoDesdeApi(status && status.state));
  } catch {
    return resultado('unknown');
  }
}

const pedirUbicacion = () => new Promise((resolve, reject) => {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    reject(new Error('sin geolocalizacion'));
    return;
  }
  // La posicion se descarta a proposito: solo interesa que el navegador registre el permiso.
  navigator.geolocation.getCurrentPosition(() => resolve(), reject, {
    timeout: ESPERA_UBICACION_MS, maximumAge: 60000, enableHighAccuracy: false,
  });
});

const pedirCamara = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  stream.getTracks().forEach((track) => track.stop());
};

const fueDenegado = (error) => !!error && (error.code === 1 || error.name === 'NotAllowedError' || error.name === 'SecurityError');

// Devuelve el estado despues del intento; un error o timeout nunca se propaga.
export async function pedirPermiso(clave) {
  let error = null;
  try {
    if (clave === 'ubicacion') await pedirUbicacion();
    else await pedirCamara();
  } catch (e) {
    error = e || new Error('fallo');
  }
  const actual = await consultarPermiso(clave);
  if (actual.estado === 'unknown') {
    if (!error) return resultado('granted');
    if (fueDenegado(error)) return resultado('denied');
  }
  return actual;
}

// Avisa cuando el usuario cambia el permiso desde el candado del navegador.
export function observarPermiso(clave, alCambiar) {
  let status = null;
  let activo = true;
  const manejador = () => { if (activo) alCambiar(); };
  try {
    navigator.permissions.query({ name: NOMBRE_API[clave] }).then((s) => {
      if (!activo || !s || !s.addEventListener) return;
      status = s;
      status.addEventListener('change', manejador);
    }).catch(() => {});
  } catch { /* sin API: no hay evento que escuchar */ }
  return () => {
    activo = false;
    if (status && status.removeEventListener) status.removeEventListener('change', manejador);
  };
}

export function alVolverAlFrente(callback) {
  if (typeof document === 'undefined') return () => {};
  const manejador = () => { if (document.visibilityState === 'visible') callback(); };
  document.addEventListener('visibilitychange', manejador);
  return () => document.removeEventListener('visibilitychange', manejador);
}

const esIphone = () => /iPhone|iPad|iPod/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');

export function ayudaBloqueado(clave) {
  const que = clave === 'ubicacion' ? 'Ubicación' : 'Cámara';
  if (esIphone()) return `Está bloqueado. Andá a Ajustes → Safari → ${que} y permitilo.`;
  return 'Está bloqueado. Tocá el candado o el ícono a la izquierda de la dirección → Permisos. '
    + 'Con la app instalada: mantené apretado el ícono → Información de la app → Permisos.';
}

export const abrirAjustes = async () => {};
