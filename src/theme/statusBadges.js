// Matches the canonical backoffice static/custom/css/nodo-badges.css.
export const statusTones = {
  gray: { bg: '#E5E7EB', bd: '#9CA3AF', tx: '#374151' },
  white: { bg: '#FFFFFF', bd: '#E5E7EB', tx: '#374151' },
  brand: { bg: '#FFEAF6', bd: '#FFB9DC', tx: '#A11F60' },
  success: { bg: '#ECFDF5', bd: '#A4F4CF', tx: '#006045' },
  danger: { bg: '#FEF0F2', bd: '#FFCCD3', tx: '#8B0836' },
  warning: { bg: '#FFF8F1', bd: '#FCD9BD', tx: '#771D1D' },
  info: { bg: '#F5F3FF', bd: '#DDD6FE', tx: '#3730A3' },
};
const relevamientos = {
  ASIGNADO: ['Asignado', 'gray'], EN_CURSO: ['En curso', 'warning'],
  FINALIZANDO: ['Finalizando', 'warning'], FINALIZADO: ['Finalizado', 'brand'],
  EN_REVISION: ['En revisión', 'info'], TERMINADO: ['Terminado', 'success'],
  VENCIDO: ['Vencido', 'warning'], PAUSADO: ['Pausado', 'warning'],
  EN_PROGRESO: ['En curso', 'warning'], SINCRONIZADO: ['Sincronizado', 'success'],
  COMPLETADO_LOCAL: ['Completado localmente', 'success'], REALIZADO: ['Realizado', 'success'],
  ERROR: ['Con error', 'danger'],
};
const casos = {
  ENVIADO: ['Enviado', 'warning'], APROBADO: ['Aprobado', 'success'],
  RECHAZADO: ['Rechazado', 'danger'], BAJA: ['Baja', 'gray'],
  DESCARTADO: ['Descartado', 'gray'],
};
function badge(map, estado) {
  const value = String(estado || '').toUpperCase();
  const fallback = value.replaceAll('_', ' ').toLowerCase();
  const [label, tone] = map[value] || [fallback.charAt(0).toUpperCase() + fallback.slice(1) || 'Pendiente', 'gray'];
  return { label, ...statusTones[tone] };
}
export const relevamientoBadge = (estado) => badge(relevamientos, estado);
export const casoBadge = (estado) => badge(casos, estado);
