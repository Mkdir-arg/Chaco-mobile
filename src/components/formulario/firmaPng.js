import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

// La firma se entrega como PNG de 600x200, fondo blanco y trazo oscuro: lo que el back
// guarda y muestra. El recuadro de firma mantiene esa proporción (3:1).
export const ANCHO_FIRMA = 600;
export const ALTO_FIRMA = 200;
export const COLOR_TRAZO = '#111827';
export const GROSOR_TRAZO = 3;

const limpiarClave = (clave) => String(clave ?? 'campo').replace(/[^\w-]/g, '_') || 'campo';
export const nombreArchivoFirma = (clave) => `firma-${limpiarClave(clave)}.png`;

// Un trazo es una lista de puntos {x, y} en coordenadas del recuadro.
export const trazoAPath = (puntos = []) => {
  if (!puntos.length) return '';
  const [primero, ...resto] = puntos;
  // Un toque sin arrastre se dibuja como un punto (línea mínima con borde redondeado).
  if (!resto.length) return `M${primero.x},${primero.y} L${primero.x + 0.1},${primero.y + 0.1}`;
  return `M${primero.x},${primero.y} ${resto.map((p) => `L${p.x},${p.y}`).join(' ')}`;
};

const bytesDeBase64 = (base64 = '') => {
  const limpio = String(base64).replace(/\s/g, '');
  const relleno = limpio.endsWith('==') ? 2 : limpio.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((limpio.length * 3) / 4) - relleno);
};

// Web: los trazos se redibujan en un <canvas> fuera de pantalla. El data: URI resultante es el
// valor del campo y sobrevive a recargar (va tal cual al borrador y a SQLite, igual que un adjunto
// ya persistido): no depende de una blob: URL ni de fetch, que la CSP de ECOM bloquea.
export const trazosAPngWeb = (trazos, { ancho, alto }) => {
  const canvas = document.createElement('canvas');
  canvas.width = ANCHO_FIRMA;
  canvas.height = ALTO_FIRMA;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, ANCHO_FIRMA, ALTO_FIRMA);
  const escalaX = ANCHO_FIRMA / (ancho || ANCHO_FIRMA);
  const escalaY = ALTO_FIRMA / (alto || ALTO_FIRMA);
  ctx.strokeStyle = COLOR_TRAZO;
  ctx.fillStyle = COLOR_TRAZO;
  ctx.lineWidth = GROSOR_TRAZO * Math.min(escalaX, escalaY) * 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const trazo of trazos) {
    if (!trazo.length) continue;
    if (trazo.length === 1) {
      ctx.beginPath();
      ctx.arc(trazo[0].x * escalaX, trazo[0].y * escalaY, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(trazo[0].x * escalaX, trazo[0].y * escalaY);
    for (const punto of trazo.slice(1)) ctx.lineTo(punto.x * escalaX, punto.y * escalaY);
    ctx.stroke();
  }
  const dataUri = canvas.toDataURL('image/png');
  return { dataUri, size: bytesDeBase64(dataUri.slice(dataUri.indexOf(',') + 1)) };
};

// Nativo: react-native-svg exporta el recuadro (con su fondo blanco) como PNG en base64.
const svgAPngNativo = (svg) => new Promise((resolve, reject) => {
  if (!svg?.toDataURL) { reject(new Error('No se pudo generar la imagen de la firma.')); return; }
  svg.toDataURL((base64) => (base64 ? resolve(base64) : reject(new Error('No se pudo generar la imagen de la firma.'))),
    { width: ANCHO_FIRMA, height: ALTO_FIRMA });
});

// Devuelve el mismo objeto que usa un ARCHIVO, con fileName firma-<clave>.png y image/png.
// En nativo queda en caché: cada pantalla lo pasa a su carpeta propia, como un archivo elegido.
export const generarPngFirma = async ({ trazos, ancho, alto, svg, clave }) => {
  const fileName = nombreArchivoFirma(clave);
  const base = { fileName, mimeType: 'image/png', width: ANCHO_FIRMA, height: ALTO_FIRMA,
    source: 'firma', capturedAt: new Date().toISOString() };
  if (Platform.OS === 'web') {
    const { dataUri, size } = trazosAPngWeb(trazos, { ancho, alto });
    return { ...base, uri: dataUri, size };
  }
  const base64 = await svgAPngNativo(svg);
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
  const uri = `${dir}${Date.now()}_${fileName}`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  return { ...base, uri, size: bytesDeBase64(base64) };
};
