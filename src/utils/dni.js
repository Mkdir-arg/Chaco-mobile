// Lectura del código del DNI argentino (PDF417 del frente, QR del dorso, JSON o texto con
// parámetros) y helpers de identidad. Salió de RelevamientoDetailScreen sin cambios para que
// Emergencia la use igual que Becas.
export const cleanDigits = (value = '') => String(value || '').replace(/\D/g, '');
export const isValidDni = (value = '') => /^\d{7,8}$/.test(cleanDigits(value));

export const normalizeToken = (value = '') =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export const normalizeSex = (value = '') => {
  const normalized = String(value || '').trim().toUpperCase();
  if (['M', 'F', 'X'].includes(normalized)) return normalized;
  if (normalized === '1') return 'M';
  if (normalized === '2') return 'F';
  if (normalized === '0' || normalized === '3') return 'X';
  if (normalized.startsWith('MASC')) return 'M';
  if (normalized.startsWith('FEM')) return 'F';
  return '';
};

export const normalizeDateText = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return '';
  // Algunos orígenes representan una fecha vacía como timestamp Unix 0.
  // En Argentina eso se visualiza como 31/12/1969; no es una fecha cargada.
  if (/^(0|1969-12-31|1970-01-01)(T.*)?$/.test(text)) return '';
  const iso = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const local = text.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (local) return `${local[1]}/${local[2]}/${local[3]}`;
  const shortLocal = text.match(/^(\d{2})[-/](\d{2})[-/](\d{2})$/);
  if (shortLocal) {
    const currentYear = new Date().getFullYear();
    const currentShortYear = currentYear % 100;
    const shortYear = Number(shortLocal[3]);
    const fullYear = shortYear <= currentShortYear ? 2000 + shortYear : 1900 + shortYear;
    return `${shortLocal[1]}/${shortLocal[2]}/${fullYear}`;
  }
  const compact = text.match(/^(\d{8})$/);
  if (compact) {
    const valueDigits = compact[1];
    const yearFirst = Number(valueDigits.slice(0, 4));
    const dayFirst = Number(valueDigits.slice(0, 2));
    const monthFirst = Number(valueDigits.slice(2, 4));
    const yearLast = Number(valueDigits.slice(4, 8));
    if (yearFirst >= 1900 && yearFirst <= 2099) {
      return `${valueDigits.slice(6, 8)}/${valueDigits.slice(4, 6)}/${valueDigits.slice(0, 4)}`;
    }
    if (dayFirst >= 1 && dayFirst <= 31 && monthFirst >= 1 && monthFirst <= 12 && yearLast >= 1900 && yearLast <= 2099) {
      return `${valueDigits.slice(0, 2)}/${valueDigits.slice(2, 4)}/${valueDigits.slice(4, 8)}`;
    }
  }
  return text;
};

export const decodeDniPart = (value = '') => {
  const text = String(value || '').trim();
  try {
    return decodeURIComponent(text.replace(/\+/g, ' ')).trim();
  } catch {
    return text;
  }
};

export const normalizeDniDateField = (value = '') => {
  const text = decodeDniPart(value);
  if (/^\d{2}[-/]\d{2}[-/]\d{2,4}$/.test(text) || /^\d{4}[-/]\d{2}[-/]\d{2}/.test(text) || /^\d{8}$/.test(text)) {
    return normalizeDateText(text);
  }
  return '';
};

export const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getParamValue = (text, keys) => {
  for (const key of keys) {
    const safeKey = escapeRegExp(key);
    const match = text.match(new RegExp(`(?:^|[?&;#\\s])${safeKey}=([^&#;\\s]+)`, 'i'));
    if (match?.[1]) return decodeURIComponent(match[1].replace(/\+/g, ' '));
    const looseMatch = text.match(new RegExp(`${safeKey}\\s*[:=]\\s*([^|@;\\n\\r]+)`, 'i'));
    if (looseMatch?.[1]) return decodeURIComponent(looseMatch[1].trim().replace(/\+/g, ' '));
  }
  return '';
};

export const flattenObject = (source, target = {}) => {
  Object.entries(source || {}).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenObject(value, target);
      return;
    }
    target[normalizeToken(key)] = value;
  });
  return target;
};

export const getObjectValue = (source, keys) => {
  const flat = flattenObject(source);
  for (const key of keys) {
    const value = flat[normalizeToken(key)];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
};

export const mapDniFields = (source) => ({
  dni_numero: cleanDigits(getObjectValue(source, ['dni', 'documento', 'numeroDocumento', 'numero_documento', 'nroDocumento', 'nro_doc', 'documentNumber'])),
  dni_sexo: normalizeSex(getObjectValue(source, ['sexo', 'gender', 'sex'])),
  dni_tramite: cleanDigits(getObjectValue(source, ['tramite', 'id_tramite', 'numeroTramite', 'numero_tramite', 'nroTramite', 'numTramite', 'transactionNumber'])),
  apellido: getObjectValue(source, ['apellido', 'apellidos', 'lastName', 'surname']),
  nombres: getObjectValue(source, ['nombres', 'nombre', 'firstName', 'givenName']),
  fecha_nacimiento: normalizeDniDateField(getObjectValue(source, ['fechaNacimiento', 'fecha_nacimiento', 'nacimiento', 'birthDate'])),
  ejemplar: getObjectValue(source, ['ejemplar', 'copy', 'version']).toUpperCase(),
  fecha_emision: normalizeDniDateField(getObjectValue(source, ['fechaEmision', 'fecha_emision', 'emision', 'issueDate'])),
});

export const stripEmptyValues = (source = {}) => {
  const result = {};
  Object.entries(source).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      result[key] = String(value).trim();
    }
  });
  return result;
};

export const parseSignedDniPayload = (raw = '') => {
  const token = String(raw).match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0];
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    const padded = `${payload.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (payload.length % 4)) % 4)}`;
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

export const parseDniCode = (rawValue = '', barcodeType = '') => {
  const raw = String(rawValue || '').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return stripEmptyValues(mapDniFields(parsed));
    }
  } catch {
    // El QR puede venir como URL o texto plano, seguimos con parsers tolerantes.
  }

  const signedPayload = parseSignedDniPayload(raw);
  if (signedPayload) {
    const signedResult = stripEmptyValues(mapDniFields(signedPayload));
    const signedHasIdentity = isValidDni(signedResult.dni_numero)
      && !!String(signedResult.apellido || '').trim()
      && !!String(signedResult.nombres || '').trim();
    if (signedHasIdentity) return signedResult;
  }

  const paramResult = stripEmptyValues({
    dni_numero: cleanDigits(getParamValue(raw, ['dni', 'documento', 'numeroDocumento', 'numero_documento', 'nroDocumento', 'nro_doc'])),
    dni_sexo: normalizeSex(getParamValue(raw, ['sexo', 'gender', 'sex'])),
    dni_tramite: cleanDigits(getParamValue(raw, ['tramite', 'id_tramite', 'numeroTramite', 'numero_tramite', 'nroTramite', 'numTramite', 'transactionNumber'])),
    apellido: getParamValue(raw, ['apellido', 'apellidos', 'lastName', 'surname']).trim(),
    nombres: getParamValue(raw, ['nombres', 'nombre', 'firstName', 'givenName']).trim(),
    fecha_nacimiento: normalizeDniDateField(getParamValue(raw, ['fechaNacimiento', 'fecha_nacimiento', 'nacimiento', 'birthDate'])),
    ejemplar: getParamValue(raw, ['ejemplar', 'copy', 'version']).trim().toUpperCase(),
    fecha_emision: normalizeDniDateField(getParamValue(raw, ['fechaEmision', 'fecha_emision', 'emision', 'issueDate'])),
  });
  if (Object.values(paramResult).some(Boolean)) return paramResult;

  const separator = raw.includes('@') ? '@' : (raw.includes('|') ? '|' : null);
  if (separator) {
    const parts = raw.split(separator).map(decodeDniPart);
    const compactParts = parts.filter(Boolean);
    const codeType = String(barcodeType || '').toUpperCase();
    const hasStandardIdentityLayout = parts.length >= 8
      && !!normalizeSex(parts[3])
      && isValidDni(cleanDigits(parts[4]));
    const looksLikePdf417 = codeType.includes('PDF417') || hasStandardIdentityLayout;
    const looksLikeQr = codeType.includes('QR') || (parts.length >= 8 && /^\d{7,8}$/.test(cleanDigits(parts[3])));

    if (separator === '@' && (hasStandardIdentityLayout || looksLikePdf417)) {
      return stripEmptyValues({
        dni_tramite: cleanDigits(getObjectValue(signedPayload || {}, ['id_tramite', 'tramite'])) || cleanDigits(parts[0]),
        apellido: parts[1] || '',
        nombres: parts[2] || '',
        dni_sexo: normalizeSex(parts[3]),
        dni_numero: cleanDigits(parts[4]),
        ejemplar: (parts[5] || '').toUpperCase(),
        fecha_nacimiento: normalizeDniDateField(parts[6]),
        fecha_emision: normalizeDniDateField(parts[7]),
      });
    }

    if (separator === '@' && looksLikeQr) {
      return stripEmptyValues({
        dni_tramite: cleanDigits(parts[0]),
        apellido: parts[1] || '',
        nombres: parts[2] || '',
        dni_numero: cleanDigits(parts[3]),
        ejemplar: (parts[4] || '').toUpperCase(),
        fecha_nacimiento: normalizeDniDateField(parts[5]),
        fecha_emision: normalizeDniDateField(parts[6]),
      });
    }

    const dniIndex = compactParts.findIndex((part) => /^\d{7,8}$/.test(cleanDigits(part)));
    const sexoIndex = compactParts.findIndex((part) => ['M', 'F', 'X', '1', '2', '3'].includes(part.toUpperCase()));
    const dates = compactParts.filter((part) => /^\d{2}\/\d{2}\/\d{4}$/.test(part) || /^\d{4}-\d{2}-\d{2}$/.test(part) || /^\d{8}$/.test(part));
    return stripEmptyValues({
      apellido: compactParts[1] || '',
      nombres: compactParts[2] || '',
      dni_sexo: sexoIndex >= 0 ? normalizeSex(compactParts[sexoIndex]) : '',
      dni_numero: dniIndex >= 0 ? cleanDigits(compactParts[dniIndex]) : '',
      dni_tramite: cleanDigits(compactParts.find((part) => /^\d{10,12}$/.test(cleanDigits(part))) || ''),
      fecha_nacimiento: normalizeDniDateField(dates[0]),
      fecha_emision: normalizeDniDateField(dates[1]),
    });
  }

  const dniMatch = raw.match(/\b\d{7,8}\b/);
  return { dni_numero: dniMatch?.[0] || '' };
};
