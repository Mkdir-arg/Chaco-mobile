// Permisos del dispositivo (variante nativa), con expo-location y expo-image-picker.
import { AppState, Linking } from 'react-native';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';

export const PERMISOS = ['ubicacion', 'camara'];
export const ETIQUETAS_ESTADO = {
  granted: 'Permitido',
  prompt: 'Sin pedir',
  denied: 'Bloqueado',
  unknown: 'No se puede saber',
};

export const estadoDesdePermiso = (permiso) => {
  if (!permiso) return { estado: 'unknown', canAskAgain: true };
  if (permiso.granted || permiso.status === 'granted') return { estado: 'granted', canAskAgain: true };
  if (permiso.status === 'undetermined') return { estado: 'prompt', canAskAgain: true };
  if (permiso.status === 'denied') return { estado: 'denied', canAskAgain: permiso.canAskAgain !== false };
  return { estado: 'unknown', canAskAgain: true };
};

const MODULOS = {
  ubicacion: { leer: () => Location.getForegroundPermissionsAsync(), pedir: () => Location.requestForegroundPermissionsAsync() },
  camara: { leer: () => ImagePicker.getCameraPermissionsAsync(), pedir: () => ImagePicker.requestCameraPermissionsAsync() },
};

export async function consultarPermiso(clave) {
  try {
    return estadoDesdePermiso(await MODULOS[clave].leer());
  } catch {
    return { estado: 'unknown', canAskAgain: true };
  }
}

export async function pedirPermiso(clave) {
  try {
    return estadoDesdePermiso(await MODULOS[clave].pedir());
  } catch {
    return consultarPermiso(clave);
  }
}

export const observarPermiso = () => () => {};

export function alVolverAlFrente(callback) {
  const sub = AppState.addEventListener('change', (estado) => { if (estado === 'active') callback(); });
  return () => sub.remove();
}

export const ayudaBloqueado = () => '';
export const abrirAjustes = () => Linking.openSettings();
