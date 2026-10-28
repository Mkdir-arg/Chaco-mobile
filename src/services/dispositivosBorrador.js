import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

// Borrador local de «Completar relevamiento»: uno por inspección y por usuario, con clave
// propia de Dispositivos. Sobrevive a cerrar la app y se borra al encolar el envío.
const PREFIJO = 'dispositivos:borrador:';
const DIR_ARCHIVOS = `${FileSystem.documentDirectory || ''}dispositivos-borradores`;

const clave = (ownerId, inspeccionId) => `${PREFIJO}${ownerId}:${inspeccionId}`;

export const leerBorrador = async (ownerId, inspeccionId) => {
  try {
    const raw = await AsyncStorage.getItem(clave(ownerId, inspeccionId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export const guardarBorrador = async (ownerId, inspeccionId, borrador) => {
  try {
    await AsyncStorage.setItem(clave(ownerId, inspeccionId), JSON.stringify(borrador));
  } catch {
    // Sin espacio o sin storage: se sigue sin borrador.
  }
};

export const archivosDelBorrador = (borrador) => [
  ...(borrador?.fotos || []),
  ...Object.values(borrador?.valores || {}).filter((valor) => valor?.uri),
];

// Los selectores dejan el archivo en caché, que el sistema puede vaciar. En nativo se copia a
// una carpeta propia; en web la URL blob: no sobrevive a recargar y el borrador no la guarda.
export const copiarParaBorrador = async (item) => {
  if (Platform.OS === 'web' || !item?.uri) return item;
  try {
    const dir = await FileSystem.getInfoAsync(DIR_ARCHIVOS);
    if (!dir.exists) await FileSystem.makeDirectoryAsync(DIR_ARCHIVOS, { intermediates: true });
    const destino = `${DIR_ARCHIVOS}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${String(item.fileName).replace(/[^\w.-]/g, '_')}`;
    await FileSystem.copyAsync({ from: item.uri, to: destino });
    const info = await FileSystem.getInfoAsync(destino, { size: true });
    return { ...item, uri: destino, size: info?.size ?? item.size ?? null };
  } catch {
    return item;
  }
};

export const borrarArchivoDelBorrador = async (item) => {
  if (Platform.OS === 'web' || !String(item?.uri || '').startsWith(DIR_ARCHIVOS)) return;
  try {
    await FileSystem.deleteAsync(item.uri, { idempotent: true });
  } catch {
    // Un archivo que no se pudo borrar no cambia nada para el agente.
  }
};

export const borrarBorrador = async (ownerId, inspeccionId, borrador) => {
  try {
    await AsyncStorage.removeItem(clave(ownerId, inspeccionId));
  } catch {
    // Idem: queda un borrador viejo que se pisa al guardar de nuevo.
  }
  for (const item of archivosDelBorrador(borrador)) await borrarArchivoDelBorrador(item);
};

export default { leerBorrador, guardarBorrador, borrarBorrador, copiarParaBorrador, borrarArchivoDelBorrador };
