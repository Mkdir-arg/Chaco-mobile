// Emergencia acepta solo JPEG (extensión .jpg/.jpeg y contenido JPEG de verdad) y hasta 5 MB
// por foto. aJpeg convierte cualquier foto elegida (PNG, WEBP, HEIC, JPEG grande) a un JPEG que
// entra en el tope: en web con canvas (webImages) y en nativo con expo-image-manipulator. Baja
// primero la calidad y después el lado, en pasos, hasta entrar; si no entra, error con `code`.
//
// No reemplaza a imagePicker/achicarAsset (Becas y Dispositivos): se llama aparte, sobre el
// asset que ya devolvió el selector.
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { forgetWebFile, readWebBlob, rememberWebFile } from '../services/webAttachments';
import { dibujarJpeg, esJpegReal, medidasReducidas, nombreJpg } from '../services/webImages';

export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_LADO = 2048;
// Cada lado se prueba con todas las calidades antes de achicar más.
export const ESCALAS = [1, 0.75, 0.5, 0.35];
export const CALIDADES = [0.85, 0.7, 0.55, 0.4];
const FONDO = '#FFFFFF';

export const ERROR_NO_CONVERTIBLE = 'JPEG_NO_CONVERTIBLE';
export const ERROR_EXCEDE = 'JPEG_EXCEDE';

const errorJpeg = (code, cause) => Object.assign(new Error(code === ERROR_EXCEDE
  ? 'La foto sigue pesando demasiado después de comprimirla. Probá con otra foto.'
  : 'No se pudo convertir la foto a JPEG. Probá sacarla de nuevo con la cámara.'), { code, cause });

// blob: URLs que creó aJpegWeb; solo esas las revoca liberarJpeg (la del selector es de quien la eligió).
const urlsPropias = new Set();

const nombreJpeg = (nombre) => (/\.jpe?g$/i.test(String(nombre || '')) ? String(nombre) : nombreJpg(nombre));

// Los lados a probar, del más grande al más chico, sin repetir medidas.
export const pasosDeLado = (ancho, alto, maxLado = MAX_LADO) => {
  const vistos = new Set();
  return ESCALAS.map((escala) => medidasReducidas(ancho, alto, Math.round(maxLado * escala)))
    .filter(({ ancho: a, alto: b }) => {
      const clave = `${a}x${b}`;
      if (a < 1 || b < 1 || vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
};

// Mismo formato que achicarAsset: image-picker lee fileName/fileSize y document-picker name/size.
const resultado = (asset, { uri, file, nombre, size, ancho, alto }) => ({
  ...asset,
  uri,
  ...(file ? { file } : {}),
  mimeType: 'image/jpeg',
  width: ancho ?? asset?.width,
  height: alto ?? asset?.height,
  fileName: nombre,
  name: nombre,
  fileSize: size,
  size,
  base64: undefined,
});

const aJpegWeb = async (asset, { maxBytes, maxLado }) => {
  let original;
  try {
    original = asset?.file || await readWebBlob(asset?.uri);
  } catch (error) {
    throw errorJpeg(ERROR_NO_CONVERTIBLE, error);
  }
  const nombre = nombreJpeg(asset?.fileName || asset?.name || original?.name);
  if (original.size <= maxBytes && await esJpegReal(original)) {
    return resultado(asset, { uri: asset.uri, file: original, nombre, size: original.size });
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(original, { imageOrientation: 'from-image' });
  } catch (error) {
    // Chrome no decodifica HEIC: no hay forma de convertirla en el navegador.
    throw errorJpeg(ERROR_NO_CONVERTIBLE, error);
  }
  try {
    for (const { ancho, alto } of pasosDeLado(bitmap.width, bitmap.height, maxLado)) {
      for (const calidad of CALIDADES) {
        const blob = await dibujarJpeg(bitmap, ancho, alto, calidad, { fondo: FONDO });
        if (!blob) throw errorJpeg(ERROR_NO_CONVERTIBLE);
        if (blob.size <= maxBytes) {
          const file = new File([blob], nombre, { type: 'image/jpeg', lastModified: original.lastModified });
          const uri = URL.createObjectURL(file);
          urlsPropias.add(uri);
          // Para que persistWebAttachment y la subida lo lean sin fetch (CSP de ECOM).
          rememberWebFile({ uri, file });
          return resultado(asset, { uri, file, nombre, size: file.size, ancho, alto });
        }
      }
    }
  } finally {
    bitmap.close?.();
  }
  throw errorJpeg(ERROR_EXCEDE);
};

const tamanoNativo = async (uri) => {
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    return info?.exists && Number.isFinite(info.size) ? info.size : null;
  } catch {
    return null;
  }
};

// Mira los bytes: el selector de iOS puede devolver HEIC con cualquier nombre.
const esJpegNativo = async (uri) => {
  try {
    const inicio = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64, position: 0, length: 3,
    });
    return String(inicio).startsWith('/9j/');
  } catch {
    return false;
  }
};

const liberar = (objeto) => {
  try {
    objeto?.release?.();
  } catch {
    // Liberar es una optimización de memoria; no cambia el resultado.
  }
};

// Cada contexto (SharedObject) retiene el bitmap hasta `release`: se libera apenas devuelve la
// imagen, que es un ImageRef independiente.
const renderizar = async (fuente, medidas) => {
  let contexto;
  try {
    contexto = ImageManipulator.manipulate(fuente);
    if (medidas) contexto.resize(medidas);
    return await contexto.renderAsync();
  } catch (error) {
    throw errorJpeg(ERROR_NO_CONVERTIBLE, error);
  } finally {
    liberar(contexto);
  }
};

const medida = (valor) => (Number.isFinite(valor) && valor > 0 ? valor : null);

// La foto se decodifica desde la uri una sola vez. Con las medidas del selector se la abre ya
// achicada al lado máximo (solo el lado largo: si el selector las diera giradas, la proporción
// se conserva igual) y no se carga el original entero; sin medidas, se abre entera. Los pasos
// siguientes se achican desde esa imagen cargada.
const aJpegNativo = async (asset, { maxBytes, maxLado }) => {
  const uri = asset?.uri;
  const nombre = nombreJpeg(asset?.fileName || asset?.name || String(uri || '').split('/').pop());
  if (await esJpegNativo(uri)) {
    const size = await tamanoNativo(uri);
    if (size != null && size <= maxBytes) return resultado(asset, { uri, nombre, size });
  }
  const anchoAsset = medida(asset?.width);
  const altoAsset = medida(asset?.height);
  let inicial = null;
  if (anchoAsset && altoAsset && Math.max(anchoAsset, altoAsset) > maxLado) {
    inicial = anchoAsset >= altoAsset ? { width: maxLado } : { height: maxLado };
  }
  const base = await renderizar(uri, inicial);
  try {
    for (const { ancho, alto } of pasosDeLado(base.width, base.height, maxLado)) {
      const mismoTamano = ancho === base.width && alto === base.height;
      const ref = mismoTamano ? base : await renderizar(base, { width: ancho, height: alto });
      try {
        for (const calidad of CALIDADES) {
          let guardada;
          try {
            guardada = await ref.saveAsync({ compress: calidad, format: SaveFormat.JPEG });
          } catch (error) {
            throw errorJpeg(ERROR_NO_CONVERTIBLE, error);
          }
          const size = await tamanoNativo(guardada.uri);
          // Sin poder medirla no se puede asegurar el tope.
          if (size == null) throw errorJpeg(ERROR_NO_CONVERTIBLE);
          if (size <= maxBytes) {
            return resultado(asset, { uri: guardada.uri, nombre, size, ancho: guardada.width, alto: guardada.height });
          }
        }
      } finally {
        if (ref !== base) liberar(ref);
      }
    }
  } finally {
    liberar(base);
  }
  throw errorJpeg(ERROR_EXCEDE);
};

// Devuelve el asset convertido: JPEG real, nombre .jpg/.jpeg, `fileSize`/`size` ≤ maxBytes y
// `mimeType: 'image/jpeg'`; en web, además, `file` con los bytes. Si la foto ya es un JPEG que
// entra, la devuelve sin recomprimir. Errores: `code` JPEG_NO_CONVERTIBLE (no se pudo leer o
// decodificar) o JPEG_EXCEDE (no entra ni con el lado y la calidad más bajos).
//
// En web el JPEG nuevo vive en una blob: URL que retiene sus bytes: la pantalla tiene que llamar
// a liberarJpeg(asset) cuando descarta la foto o cuando ya la envió o la persistió (después,
// la uri deja de poder leerse).
export const aJpeg = (asset, { maxBytes = MAX_BYTES, maxLado = MAX_LADO } = {}) => (
  Platform.OS === 'web'
    ? aJpegWeb(asset, { maxBytes, maxLado })
    : aJpegNativo(asset, { maxBytes, maxLado })
);

// Suelta la blob: URL que creó aJpeg en web (y el File registrado para leerla). Con cualquier
// otro asset (el original del selector, uno de nativo, null) no hace nada. Devuelve si liberó.
export const liberarJpeg = (asset) => {
  const uri = asset?.uri;
  if (!urlsPropias.has(uri)) return false;
  urlsPropias.delete(uri);
  forgetWebFile(uri);
  try {
    URL.revokeObjectURL(uri);
  } catch {
    // Revocar solo libera memoria.
  }
  return true;
};
