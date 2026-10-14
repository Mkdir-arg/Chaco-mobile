export const ASSIGNMENT_TIME_ZONE = 'America/Argentina/Buenos_Aires';
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

// Las fechas antiguas sin hora representan días enteros en Argentina.
export const parseAssignmentDate = (value, { endOfDay = false } = {}) => {
  if (value == null || value === '') return null;
  let input = value;
  if (typeof value === 'string') {
    const dateOnly = value.match(DATE_ONLY_PATTERN);
    if (dateOnly) {
      const [, year, month, day] = dateOnly;
      const check = new Date(`${value}T12:00:00Z`);
      if (!Number.isFinite(check.getTime()) || check.getUTCFullYear() !== Number(year)
        || check.getUTCMonth() + 1 !== Number(month) || check.getUTCDate() !== Number(day)) return null;
      input = `${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}-03:00`;
    } else if (LOCAL_ISO_PATTERN.test(value)) {
      input = `${value}-03:00`;
    }
  }
  const date = new Date(input);
  return Number.isFinite(date.getTime()) ? date : null;
};

const argentinaParts = (date) => Object.fromEntries(new Intl.DateTimeFormat('es-AR', {
  timeZone: ASSIGNMENT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));

export const dateKey = (value) => {
  const date = parseAssignmentDate(value);
  if (!date) return '';
  const {year, month, day} = argentinaParts(date);
  return `${year}-${month}-${day}`;
};

export const formatDate = (value, { includeTime = false } = {}) => {
  const date = parseAssignmentDate(value);
  if (!date) return value ? String(value) : '-';
  const {year, month, day, hour, minute} = argentinaParts(date);
  const label = `${day}/${month}/${year}`;
  return includeTime && !DATE_ONLY_PATTERN.test(String(value)) ? `${label} ${hour}:${minute}` : label;
};

export const isDateTimeActive = (start, end, now = new Date()) => {
  const startDate = parseAssignmentDate(start);
  const endDate = parseAssignmentDate(end || start, { endOfDay: true });
  const current = parseAssignmentDate(now);
  return Boolean(startDate && endDate && current && startDate <= current && current <= endDate);
};

export const isDateTimeCurrentOrFuture = (end, now = new Date()) => {
  const endDate = parseAssignmentDate(end, { endOfDay: true });
  const current = parseAssignmentDate(now);
  return Boolean(endDate && current && current <= endDate);
};

export const formatDateTimeRange = (start, end) => {
  const first = parseAssignmentDate(start);
  const last = parseAssignmentDate(end || start, { endOfDay: true });
  if (!first || !last || first > last) return 'Sin período válido';
  const a = argentinaParts(first);
  const b = argentinaParts(last);
  const sameYear = a.year === b.year;
  const dayLabel = (parts) => `${parts.day}/${parts.month}${sameYear ? '' : `/${parts.year}`}`;
  const sameDay = dateKey(first) === dateKey(last);
  const fullDays = a.hour === '00' && a.minute === '00' && a.second === '00'
    && b.hour === '23' && b.minute === '59';
  if (fullDays) return sameDay ? dayLabel(a) : `${dayLabel(a)} a ${dayLabel(b)}`;
  return `${dayLabel(a)} ${a.hour}:${a.minute} a ${sameDay ? '' : `${dayLabel(b)} `}${b.hour}:${b.minute}`;
};

export const closingSoonLabel = (start, end, now = new Date()) => {
  if (!isDateTimeActive(start, end, now)) return '';
  const closing = parseAssignmentDate(end || start, { endOfDay: true });
  const remaining = closing.getTime() - parseAssignmentDate(now).getTime();
  if (remaining <= 0 || remaining >= 2 * 60 * 60 * 1000) return '';
  const {hour, minute} = argentinaParts(closing);
  return `Cierra a las ${hour}:${minute}`;
};

export const isAssignmentVisible = (item, now = new Date()) => Boolean(item.has_pending_operations)
  || isDateTimeCurrentOrFuture(item.fecha_hasta || item.fecha_asignada || item.created_at, now);

// Actualizar justo al abrir/cerrar o entrar en la ventana de aviso, y al menos cada minuto.
export const nextAssignmentRefreshMs = (assignments, now = new Date()) => {
  const current = parseAssignmentDate(now)?.getTime() || Date.now();
  const boundaries = assignments.flatMap((item) => {
    const start = parseAssignmentDate(item.fecha_asignada)?.getTime();
    const end = parseAssignmentDate(item.fecha_hasta || item.fecha_asignada, { endOfDay: true })?.getTime();
    return [start, end == null ? null : end + 1, end == null ? null : end - 2 * 60 * 60 * 1000 + 1];
  }).filter((stamp) => stamp != null && stamp > current);
  return Math.max(1, Math.min(60_000, ...boundaries.map((stamp) => stamp - current)));
};
