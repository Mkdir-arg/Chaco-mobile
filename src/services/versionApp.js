import Constants from 'expo-constants';
import { getStoredBecasUser } from './becasApi';

export const versionActual = () => Constants?.expoConfig?.version || null;

// x.y.z simple: tolera partes faltantes ("1.2") y sufijos ("1.2.3-beta", "v1.2.3+4").
const partes = (version) => {
  const match = String(version ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  return match ? [1, 2, 3].map((i) => Number(match[i] || 0)) : null;
};

// -1 si a < b, 0 si son iguales (o no se pueden comparar), 1 si a > b.
export const compararVersiones = (a, b) => {
  const [pa, pb] = [partes(a), partes(b)];
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
};

export const requiereActualizacion = (versionMinima) => {
  if (!partes(versionMinima) || !partes(versionActual())) return false;
  return compararVersiones(versionActual(), versionMinima) < 0;
};

export const requiereActualizacionGuardada = async () => {
  try {
    const user = await getStoredBecasUser();
    return requiereActualizacion(user?.version_minima ?? null);
  } catch {
    return false;
  }
};
