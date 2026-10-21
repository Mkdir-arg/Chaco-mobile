// En web el selector devuelve una blob: URL que la CSP no deja leer con fetch.
// Guardamos el File que viene al lado para leerlo sin red (ver webAttachments).
import * as Picker from 'expo-image-picker';
import { rememberWebFile } from './webAttachments';

export * from 'expo-image-picker';

const recordar = (result) => {
  result?.assets?.forEach(rememberWebFile);
  return result;
};

export const launchCameraAsync = async (options) => recordar(await Picker.launchCameraAsync(options));
export const launchImageLibraryAsync = async (options) => recordar(await Picker.launchImageLibraryAsync(options));
