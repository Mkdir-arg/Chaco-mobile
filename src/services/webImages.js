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

export const esHeic = (file) => /heic|heif/i.test(String(file?.type || '')) || /[.](heic|heif)$/i.test(String(file?.name || ''));

// Dibuja la imagen decodificada en un canvas de ancho x alto y la codifica como JPEG. Con
// `fondo`, pinta antes ese color: un PNG con transparencia sale negro en JPEG si no.
// null si el navegador no pudo codificarla.
export const dibujarJpeg = async (bitmap, ancho, alto, calidad, { fondo = null } = {}) => {
  const canvas = document.createElement('canvas');
  canvas.width = ancho;
  canvas.height = alto;
  const contexto = canvas.getContext('2d');
  if (fondo) {
    contexto.fillStyle = fondo;
    contexto.fillRect(0, 0, ancho, alto);
  }
  contexto.drawImage(bitmap, 0, 0, ancho, alto);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', calidad));
};

// JPEG de verdad: los tres primeros bytes son FF D8 FF, diga lo que diga la extensión.
export const esJpegReal = async (blob) => {
  try {
    const bytes = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    return bytes.length === 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } catch {
    return false;
  }
};

// null cuando no conviene tocarla: no es imagen, ya es chica (salvo HEIC), el navegador no la sabe
// decodificar (HEIC en Chrome) o el resultado no pesa menos que el original.
export const comprimirImagen = async (file) => {
  // El HEIC se intenta convertir aunque sea chico (best-effort: Chrome no lo decodifica
  // y queda el original, que el backend acepta).
  const heic = esHeic(file);
  if (!heic && (!String(file?.type || '').startsWith('image/') || file.size <= UMBRAL_BYTES)) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const { ancho, alto } = medidasReducidas(bitmap.width, bitmap.height);
    const blob = await dibujarJpeg(bitmap, ancho, alto, CALIDAD);
    if (!blob || (!heic && blob.size >= file.size)) return null;
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
