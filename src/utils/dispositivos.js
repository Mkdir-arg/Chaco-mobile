// Textos y reglas puras del módulo Dispositivos (sin React ni red).

export const MAX_ARCHIVO_BYTES = 5 * 1024 * 1024;
const EXT_FOTO = ['jpg', 'jpeg', 'png', 'webp'];
const EXT_ADJUNTO = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'];
const MIME_POR_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
};
const EXT_POR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };

export const CRITICIDADES = [
  { valor: 'BAJA', titulo: 'Baja' },
  { valor: 'MEDIA', titulo: 'Media' },
  { valor: 'ALTA', titulo: 'Alta' },
];

export const direccionDe = (edificio = {}) => {
  const calle = [edificio.calle, edificio.numero].filter(Boolean).join(' ');
  const piso = edificio.piso_departamento ? `(${edificio.piso_departamento})` : '';
  const cp = edificio.codigo_postal ? `CP ${edificio.codigo_postal}` : '';
  return [[calle, piso].filter(Boolean).join(' '), edificio.localidad, edificio.provincia, cp]
    .filter(Boolean).join(', ');
};

export const mapaUrl = (edificio = {}) => {
  const { latitud, longitud } = edificio;
  if (latitud == null || longitud == null || latitud === '' || longitud === '') return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitud},${longitud}`)}`;
};

// Secciones de la lista: «vencida» es la que dice el server, no el reloj del teléfono.
export const seccionesDeLista = (items = []) => {
  const porVencimiento = (a, b) => String(a.fecha_vencimiento || '9999').localeCompare(String(b.fecha_vencimiento || '9999'));
  const sinEnvio = items.filter((item) => !item.envio);
  return {
    pendientes: sinEnvio.filter((item) => !item.vencida).sort(porVencimiento),
    vencidos: sinEnvio.filter((item) => item.vencida).sort(porVencimiento),
    enviados: items.filter((item) => item.envio),
  };
};

export const ETIQUETA_ENVIO = {
  pendiente: 'Pendiente de envío',
  en_cola: 'Enviando',
  error: 'Con error',
  enviado: 'Enviado',
};

const TEXTO_POR_CODE = {
  REASIGNADA: 'Este relevamiento se reasignó a otra persona; lo cargado queda en el teléfono.',
  CANCELADA: 'Este relevamiento se canceló; no hace falta enviarlo.',
  YA_REALIZADA: 'Este relevamiento ya figura como realizado; no se envió de nuevo.',
  ESTADO_NO_ADMITE: 'El relevamiento ya no admite cargas en su estado actual.',
  NO_ENCONTRADA: 'El relevamiento ya no está disponible para vos.',
  REINTENTOS_AGOTADOS: 'No se pudo enviar después de varios intentos.',
  ARCHIVO_LOCAL_FALTANTE: 'Falta un archivo adjunto en el teléfono; volvé a cargarlo.',
  DATOS_INVALIDOS: 'El servidor rechazó los datos cargados. Corregí lo marcado y volvé a enviar.',
};

// Qué mostrarle al agente de un envío en error: título por `code` (nunca por el texto del
// mensaje) y, en un 400, cada clave con la etiqueta del campo.
export const describirEnvio = (envio, etiquetas = {}) => {
  if (!envio || envio.estado !== 'error') return null;
  const claves = envio.claves && typeof envio.claves === 'object'
    ? Object.entries(envio.claves).map(([clave, texto]) => ({ clave, etiqueta: etiquetas[clave] || clave, texto: String(texto) }))
    : [];
  const titulo = TEXTO_POR_CODE[envio.code] || envio.detail || envio.code || 'No se pudo enviar.';
  // El detail del back solo suma en un 400 sin claves: en lo demás manda el texto por code.
  const detalle = envio.code === 'DATOS_INVALIDOS' && !claves.length ? envio.detail || '' : '';
  return { titulo, detalle, claves, descartada: !!envio.descartada };
};

export const etiquetasDeCampos = (formulario) => {
  const mapa = {};
  const recorrer = (items = []) => items.forEach((item) => {
    if (item?.items) recorrer(item.items);
    else if (item?.clave && item.texto) mapa[item.clave] = item.texto;
  });
  recorrer(formulario?.definicion?.items);
  return mapa;
};

const extensionDe = (nombre = '') => {
  const limpio = String(nombre).split('?')[0].split('#')[0];
  const punto = limpio.lastIndexOf('.');
  return punto >= 0 ? limpio.slice(punto + 1).toLowerCase() : '';
};

// Normaliza lo que devuelven los selectores (image-picker usa fileName/fileSize,
// document-picker name/size) y valida tipo y tamaño. Lanza Error con texto para el agente.
export const prepararAsset = (asset = {}, { tipo = 'foto' } = {}) => {
  const permitidas = tipo === 'foto' ? EXT_FOTO : EXT_ADJUNTO;
  let nombre = asset.fileName || asset.name || String(asset.uri || '').split('?')[0].split('/').pop() || '';
  let ext = extensionDe(nombre);
  if (!permitidas.includes(ext)) {
    const deMime = EXT_POR_MIME[String(asset.mimeType || '').toLowerCase()];
    if (!deMime || !permitidas.includes(deMime)) {
      throw new Error(tipo === 'foto'
        ? 'La foto debe ser JPG, PNG o WEBP.'
        : 'El archivo debe ser JPG, PNG, WEBP, HEIC o PDF.');
    }
    ext = deMime;
    nombre = `${nombre.replace(/\.[^.]*$/, '') || 'archivo'}.${ext}`;
  }
  const size = asset.fileSize ?? asset.size ?? asset.file?.size ?? null;
  if (Number(size) > MAX_ARCHIVO_BYTES) throw new Error('El archivo no puede superar los 5 MB.');
  return {
    uri: asset.uri,
    fileName: nombre,
    mimeType: MIME_POR_EXT[ext],
    size: size == null ? null : Number(size),
  };
};
