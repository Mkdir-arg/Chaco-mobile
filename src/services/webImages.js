// En nativo la app comprime cada foto (`quality: 0.8`). En web expo-image-picker
// ignora esa opcion y entrega el archivo original: la foto de un celular nuevo pasa los
// 5 MB que acepta el backend y se rechaza, y cada MB de mas pesa en la subida por datos
// moviles. Aca la achicamos al elegirla, con el mismo criterio de calidad.
const LADO_MAXIMO = 2048;
const CALIDAD = 0.8;
const UMBRAL_BYTES = 1.5 * 1024 * 1024;

export const medidasReducidas = (ancho, alto, maximo = LADO_MAXIMO) => {
  const escala = Math.min(1, maximo / Math.max(ancho, alto));
  return { ancho: Math.round(ancho * escala), alto: Math.round(alto * escala) };
};

export const nombreJpg = (nombre) => `${String(nombre || '').replace(/\.[^.]*$/, '') || 'foto'}.jpg`;

// null cuando no conviene tocarla: no es imagen, ya es chica, el navegador no la sabe
// decodificar (HEIC en Chrome) o el resultado no pesa menos que el original.
export const comprimirImagen = async (file) => {
  if (!String(file?.type || '').startsWith('image/') || file.size <= UMBRAL_BYTES) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const { ancho, alto } = medidasReducidas(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = ancho;
    canvas.height = alto;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, ancho, alto);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', CALIDAD));
    if (!blob || blob.size >= file.size) return null;
    const reducida = new File([blob], nombreJpg(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
    return { file: reducida, ancho, alto };
  } finally {
    bitmap.close?.();
  }
};

// Sirve para los dos selectores: image-picker usa fileName/fileSize y document-picker
// name/size; se pisan los cuatro para que nadie lea el tamano del original.
export const achicarAsset = async (asset) => {
  if (!asset?.file || typeof document === 'undefined') return asset;
  const reducida = await comprimirImagen(asset.file);
  if (!reducida) return asset;
  const { file } = reducida;
  return {
    ...asset,
    uri: URL.createObjectURL(file),
    file,
    mimeType: 'image/jpeg',
    width: reducida.ancho,
    height: reducida.alto,
    fileName: file.name,
    name: file.name,
    fileSize: file.size,
    size: file.size,
    base64: undefined,
  };
};
