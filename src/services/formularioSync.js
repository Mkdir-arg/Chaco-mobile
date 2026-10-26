export const GRACE_EXPIRED = 'GRACIA_VENCIDA';
export const INVALID_SUBMISSION = 'ALTA_INVALIDA';
export const REJECTED_ATTACHMENTS = 'ADJUNTOS_RECHAZADOS';
// Cargas que la app no resuelve sola: piden una decisión del relevador.
export const CODIGOS_REQUIEREN_ATENCION = [GRACE_EXPIRED, INVALID_SUBMISSION, REJECTED_ATTACHMENTS];
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const apiErrorMessage = (payload, fallback = 'Error de sincronización') => {
  const flatten = (value, prefix = '') => {
    if (Array.isArray(value)) return value.flatMap((item) => flatten(item, prefix));
    if (value && typeof value === 'object') return Object.entries(value)
      .flatMap(([key, item]) => flatten(item, key === 'non_field_errors' ? prefix : [prefix, key].filter(Boolean).join('.')));
    return value == null ? [] : [`${prefix ? `${prefix}: ` : ''}${String(value)}`];
  };
  if (payload?.detail) return flatten(payload.detail).join('\n');
  if (payload?.error) return flatten(payload.error).join('\n');
  // `code` y `pausado` son para la app, no para el texto que ve el usuario.
  const visible = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => !['code', 'pausado'].includes(key)))
    : payload;
  return flatten(visible).join('\n') || fallback;
};

export const isGraceExpired = (error) => {
  const status = Number(error?.status || error?.statusCode);
  return status === 409 && (error?.payload?.code === GRACE_EXPIRED
    || /cerr[oó].*m[aá]s de 24 horas|gracia.*vencid/i.test(String(error?.message || '')));
};

export const validateAttachmentMetadata = ({ fileName, uri, size }) => {
  const name = String(fileName || String(uri || '').split('/').pop() || '').split('?')[0];
  if (!/\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(name)) {
    throw new Error('El adjunto debe ser JPG, JPEG, PNG, WEBP, HEIC, HEIF o PDF.');
  }
  if (Number(size) > MAX_ATTACHMENT_BYTES) throw new Error('El adjunto no puede superar los 5 MB.');
};
