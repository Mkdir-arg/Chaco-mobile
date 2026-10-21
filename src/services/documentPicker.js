// En web el selector devuelve una blob: URL que la CSP no deja leer con fetch.
// Guardamos el File que viene al lado para leerlo sin red (ver webAttachments).
import * as Picker from 'expo-document-picker';
import { rememberWebFile } from './webAttachments';

export * from 'expo-document-picker';

const recordar = (result) => {
  result?.assets?.forEach(rememberWebFile);
  return result;
};

export const getDocumentAsync = async (options) => recordar(await Picker.getDocumentAsync(options));
