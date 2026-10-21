// Persist bytes in the same SQLite transaction as the capture and its outbox.
// Object URLs expire on reload. Data URLs survive browser/process restarts.
//
// Nada de esto usa fetch. La CSP de los ambientes de ECOM tiene un `connect-src` sin
// `blob:` ni `data:`, y el navegador rechaza un fetch a cualquiera de los dos: asi
// moria cada adjunto, al guardarlo (blob:) o al subirlo (data:). Los selectores de Expo
// entregan el File junto con su blob: URL; lo guardamos al elegir (ver imagePicker y
// documentPicker) y lo leemos directo. El registro vive lo mismo que la URL: los dos
// se pierden al recargar la pagina.
const archivosElegidos = new Map();

export const rememberWebFile = (asset) => {
  if (asset?.uri && asset?.file) archivosElegidos.set(asset.uri, asset.file);
  return asset;
};

const dataUriToBlob = (uri) => {
  const coma = uri.indexOf(',');
  const cabecera = uri.slice(5, coma);
  const contenido = uri.slice(coma + 1);
  const binario = cabecera.endsWith(';base64') ? atob(contenido) : decodeURIComponent(contenido);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return new Blob([bytes], { type: cabecera.split(';')[0] || 'application/octet-stream' });
};

const blobToDataUri = async (blob, mimeType) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binario = '';
  // De a pedazos: un String.fromCharCode con 5 MB de argumentos desborda la pila.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || mimeType || 'application/octet-stream'};base64,${btoa(binario)}`;
};

export const readWebBlob = async (uri) => {
  const value = String(uri || '');
  if (value.startsWith('data:')) return dataUriToBlob(value);
  const archivo = archivosElegidos.get(value);
  if (archivo) return archivo;
  // Sin File registrado solo queda pedirlo por red. Bajo la CSP de ECOM una blob: URL
  // falla igual, pero en desarrollo (sin CSP) sigue funcionando.
  try {
    const response = await fetch(value);
    if (response.ok) return await response.blob();
  } catch {}
  throw new Error('No se pudo leer el adjunto. Volvé a seleccionarlo.');
};

export const persistWebAttachment = async ({ uri, mimeType, size }) => {
  if (String(uri).startsWith('data:')) return { uri, mimeType, size };
  const blob = await readWebBlob(uri);
  return { uri: await blobToDataUri(blob, mimeType), mimeType: blob.type || mimeType, size: blob.size };
};
