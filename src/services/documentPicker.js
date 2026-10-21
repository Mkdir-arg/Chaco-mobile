// En web el selector devuelve una blob: URL que la CSP no deja leer con fetch.
// Guardamos el File que viene al lado para leerlo sin red (ver webAttachments), y las
// fotos grandes se achican antes (ver webImages).
import * as Picker from 'expo-document-picker';
import { rememberWebFile } from './webAttachments';
import { achicarAsset } from './webImages';

export * from 'expo-document-picker';

const recordar = async (result) => {
  if (!result?.assets) return result;
  const assets = await Promise.all(result.assets.map(achicarAsset));
  assets.forEach(rememberWebFile);
  return { ...result, assets };
};

export const getDocumentAsync = async (options) => recordar(await Picker.getDocumentAsync(options));
