import { Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

// En web la red la dice `navigator.onLine`, no NetInfo: NetInfo web guarda el último estado y su
// `isInternetReachable` es un HEAD a `/` del origen de la PWA (no del API) que, si falló, se repite
// recién a los 5 s; al volver la red puede seguir diciendo «sin internet» por una prueba hecha sin
// señal, y las colas no salían. Un fetch que igual falla queda como falla de red y se reintenta.
const navegadorConEstado = () => (
  Platform.OS === 'web' && typeof navigator !== 'undefined' && typeof navigator?.onLine === 'boolean'
);

// Un estado de NetInfo a «hay red». En web, el del navegador.
export const hayRedEn = (state) => {
  if (navegadorConEstado()) return navigator.onLine;
  return !!state?.isConnected && state?.isInternetReachable !== false;
};

export const hayRed = async () => {
  if (navegadorConEstado()) return navigator.onLine;
  try {
    return hayRedEn(await NetInfo.fetch());
  } catch {
    return false;
  }
};

// Llama a `alVolver` cuando la red pasa de no estar a estar. En web, el evento `online` del
// navegador; en nativo, NetInfo. Devuelve la función para dejar de escuchar.
export const escucharReconexion = (alVolver) => {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const alEstarEnLinea = () => alVolver();
    window.addEventListener('online', alEstarEnLinea);
    return () => window.removeEventListener('online', alEstarEnLinea);
  }
  let conectado = null;
  return NetInfo.addEventListener((state) => {
    const ahora = hayRedEn(state);
    const antes = conectado;
    conectado = ahora;
    if (!antes && ahora) alVolver();
  });
};
