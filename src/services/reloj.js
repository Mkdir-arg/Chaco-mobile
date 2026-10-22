import AsyncStorage from '@react-native-async-storage/async-storage';

// El reloj del teléfono puede estar corrido (hora manual, zona mal configurada). El
// servidor responde su hora en el header `Date`; con eso se calcula el desfase y se
// usa para fechar capturas y para decidir si la gracia de un relevamiento venció.
// El header tiene precisión de 1 s y hay latencia de red: solo se corrige un desfase
// mayor a UMBRAL_MS, para no meter ruido cuando el reloj está bien.
const DESFASE_KEY = 'reloj_desfase_ms';
const UMBRAL_MS = 60 * 1000;

let desfase = 0;
let registrado = false;

const guardar = () => AsyncStorage.setItem(DESFASE_KEY, String(desfase)).catch(() => {});

// Arranque offline: se retoma el último desfase conocido, salvo que ya haya llegado
// una respuesta del servidor más reciente que lo guardado.
export const cargarDesfase = async () => {
  try {
    const valor = Number(await AsyncStorage.getItem(DESFASE_KEY));
    if (!registrado && Number.isFinite(valor)) desfase = valor;
  } catch {
    // Sin storage se trabaja con la hora del dispositivo.
  }
};
cargarDesfase();

export const registrarHoraServidor = (dateHeader) => {
  if (!dateHeader) return;
  const servidor = Date.parse(String(dateHeader));
  if (!Number.isFinite(servidor)) return;
  const diferencia = servidor - Date.now();
  const nuevo = Math.abs(diferencia) > UMBRAL_MS ? diferencia : 0;
  registrado = true;
  if (nuevo !== desfase) {
    desfase = nuevo;
    guardar();
  }
};

export const desfaseMs = () => desfase;

export const ahoraCorregido = () => new Date(Date.now() + desfase);
