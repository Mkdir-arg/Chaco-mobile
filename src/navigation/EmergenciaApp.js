import React, { useEffect, useRef, useState } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import Banner from '../components/Banner';
import CustomButton from '../components/CustomButton';
import SettingsPanel from '../components/SettingsPanel';
import EmergenciaInicioScreen from '../screens/EmergenciaInicioScreen';
import EmergenciaMisEnviosScreen from '../screens/EmergenciaMisEnviosScreen';
import EmergenciaFormulario1Screen from '../screens/EmergenciaFormulario1Screen';
import EmergenciaMisDispositivosScreen from '../screens/EmergenciaMisDispositivosScreen';
import EmergenciaEntregasScreen from '../screens/EmergenciaEntregasScreen';
import EmergenciaRecibirEntregaScreen from '../screens/EmergenciaRecibirEntregaScreen';
import EmergenciaLlegadaBuscarScreen from '../screens/EmergenciaLlegadaBuscarScreen';
import EmergenciaDerivacionScreen from '../screens/EmergenciaDerivacionScreen';
import EmergenciaIntegrantesScreen from '../screens/EmergenciaIntegrantesScreen';
import {
  descartar, getBorradorEnCurso, getLocalidadesGuardadas, getPendingCount, getResumenPendientes, reintentar, syncPendientes,
} from '../services/emergenciaCola';
import { avisoDeSalida } from '../utils/emergencia';

const SYNC_INTERVAL_MS = 8000;
const RECONNECT_DELAY_MS = 1800;

const TITULOS = {
  envios: 'Ingreso de familias',
  formulario: 'Relevar una familia',
  kits_dispositivos: 'Recepción de kits',
  kits_entregas: 'Recepción de kits',
  kits_recibir: 'Recibir entrega',
  llegadas_dispositivos: 'Llegada de familias',
  llegadas_buscar: 'Llegada de familias',
  llegadas_derivacion: 'Derivación',
  llegadas_integrantes: 'Integrantes',
};
// Las vistas que se vuelven a pedir con el botón de sincronizar del Banner.
const VISTAS_RECARGABLES = ['inicio', 'kits_dispositivos', 'kits_entregas', 'llegadas_dispositivos', 'llegadas_integrantes'];
const VISTAS_M1 = ['envios', 'formulario'];
const INICIO = { vista: 'inicio', uuid: null };

// Al volver la red, `alVolver`. En web, el evento `online` del navegador (la cola mira
// `navigator.onLine`: el estado guardado de NetInfo web puede seguir diciendo «sin internet»); en
// nativo, NetInfo. Devuelve la función para dejar de escuchar.
const escucharReconexion = (alVolver) => {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const alEstarEnLinea = () => alVolver();
    window.addEventListener('online', alEstarEnLinea);
    return () => window.removeEventListener('online', alEstarEnLinea);
  }
  let conectado = null;
  return NetInfo.addEventListener((state) => {
    const hayRed = !!state?.isConnected && state?.isInternetReachable !== false;
    const antes = conectado;
    conectado = hayRed;
    if (!antes && hayRed) alVolver();
  });
};

// Módulo Emergencia: inicio con los accesos del perfil -> M1 («Ingreso de familias»: mis envíos y
// el Formulario 1), M2 («Llegada de familias»: mis dispositivos -> buscar por DNI -> derivación ->
// integrantes, con conexión) y M3 («Recepción de kits»: mis dispositivos -> entregas por recibir ->
// recibir, sin cola y con conexión). Como Dispositivos, no importa nada de los otros módulos: comparte sesión, tema
// y componentes. La cola de M1 se sincroniza solo mientras este árbol está montado.
export default function EmergenciaApp({ onCambiarModulo }) {
  const { theme } = useTheme();
  const { showAlert, showToast } = useToast();
  const { user, logout } = useAuth();
  const displayName = user?.nombre || user?.username || 'Usuario';
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [pantalla, setPantalla] = useState({ vista: 'inicio', uuid: null });
  const [recarga, setRecarga] = useState(0);
  const [cargandoPerfil, setCargandoPerfil] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [pendientes, setPendientes] = useState(0);
  const [syncTick, setSyncTick] = useState(0);
  const [enviadosTick, setEnviadosTick] = useState(0);
  // Una acción con conexión mandándose (recibir kits, aceptar o rechazar una derivación, agregar una
  // persona): no se sale de la pantalla hasta saber el resultado.
  const [enviando, setEnviando] = useState(false);
  // Hasta cuándo (ms) el back pidió no buscar por DNI (429 de §13.2): sobrevive a volver y re-entrar.
  const [esperaBuscarHasta, setEsperaBuscarHasta] = useState(0);
  // La pasada de fondo en curso (su promesa) y si hay una manual: la manual espera a la de fondo.
  const fondo = useRef(null);
  const manual = useRef(false);
  const reconexion = useRef(null);
  const montado = useRef(true);

  const refrescarEstado = async () => {
    try {
      const cantidad = await getPendingCount();
      if (!montado.current) return;
      setPendientes(cantidad);
      setSyncTick((tick) => tick + 1);
    } catch {
      // Sin base local legible: se deja el estado anterior.
    }
  };

  const avisarEnviados = (resultado) => {
    if (resultado?.synced > 0 && montado.current) setEnviadosTick((tick) => tick + 1);
  };

  const sincronizarDeFondo = () => {
    if (fondo.current || manual.current) return fondo.current;
    fondo.current = (async () => {
      try {
        avisarEnviados(await syncPendientes());
      } catch {
        // Sin conexión o error temporal: queda en cola.
      } finally {
        await refrescarEstado();
      }
    })().finally(() => { fondo.current = null; });
    return fondo.current;
  };

  useEffect(() => {
    montado.current = true;
    sincronizarDeFondo();
    // La lista de localidades se guarda al entrar y se refresca una vez por día (§5).
    getLocalidadesGuardadas().catch(() => {});
    const timer = setInterval(sincronizarDeFondo, SYNC_INTERVAL_MS);
    const desuscribir = escucharReconexion(() => {
      if (reconexion.current) clearTimeout(reconexion.current);
      reconexion.current = setTimeout(sincronizarDeFondo, RECONNECT_DELAY_MS);
    });
    return () => {
      montado.current = false;
      clearInterval(timer);
      desuscribir?.();
      if (reconexion.current) clearTimeout(reconexion.current);
    };
  }, []);

  const sincronizarAhora = async () => {
    if (VISTAS_RECARGABLES.includes(pantalla.vista)) setRecarga((valor) => valor + 1);
    if (manual.current) return;
    manual.current = true;
    setSincronizando(true);
    try {
      // Si hay una pasada de fondo, se espera a que termine y después se reintenta todo.
      if (fondo.current) await fondo.current.catch(() => {});
      const pendientesAntes = await getPendingCount().catch(() => 0);
      if (pendientesAntes > 0) {
        const result = await reintentar();
        avisarEnviados(result);
        if (result?.offline) showToast({ type: 'warning', message: 'Sin conexión. Se envía solo cuando vuelva.' });
        else if (result?.failed > 0) showToast({ type: 'warning', message: `No se pudo enviar ${result.failed}. Mirá «Mis envíos».` });
        else if (result?.synced > 0) showToast({ type: 'success', message: `Se enviaron ${result.synced}.` });
      } else if (VISTAS_M1.includes(pantalla.vista)) {
        showToast({ type: 'info', message: 'No había nada para enviar.' });
      }
    } catch (error) {
      showToast({ type: 'error', message: error?.message || 'No se pudo sincronizar.' });
    } finally {
      manual.current = false;
      if (montado.current) setSincronizando(false);
      await refrescarEstado();
    }
  };

  const salir = async () => {
    setSettingsVisible(false);
    let aviso = null;
    try {
      aviso = avisoDeSalida(await getResumenPendientes());
    } catch {
      aviso = null;
    }
    if (aviso) {
      showAlert('Cerrar sesión', aviso, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Salir', style: 'destructive', onPress: () => logout() },
      ]);
      return;
    }
    logout();
  };

  // «Relevar una familia»: con un formulario sin terminar se pregunta. Hay un solo borrador en curso:
  // empezar otra descarta el anterior, y eso se confirma aparte.
  const relevarNueva = async () => {
    let enCursoBorrador = null;
    try {
      enCursoBorrador = await getBorradorEnCurso();
    } catch {
      enCursoBorrador = null;
    }
    if (!enCursoBorrador) {
      setPantalla({ vista: 'formulario', uuid: null });
      return;
    }
    const { uuid_cliente: uuidEnCurso, resumen } = enCursoBorrador;
    const empezarOtra = () => showAlert('Empezar otra familia',
      `Se descarta lo cargado de «${resumen}», con sus fotos. No se puede deshacer.`, [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Descartar y empezar',
          style: 'destructive',
          onPress: async () => {
            try {
              await descartar(uuidEnCurso);
            } catch (error) {
              showToast({ type: 'error', message: error?.message || 'No se pudo descartar.' });
              return;
            }
            if (montado.current) setPantalla({ vista: 'formulario', uuid: null });
          },
        },
      ]);
    showAlert('Formulario sin terminar', `Tenés sin terminar «${resumen}».`, [
      { text: 'Seguir con ese', onPress: () => setPantalla({ vista: 'formulario', uuid: uuidEnCurso }) },
      { text: 'Empezar otra', style: 'destructive', onPress: empezarOtra },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  };

  const abrir = (acceso) => {
    if (acceso.clave === 'relevar') {
      setPantalla({ vista: 'envios', uuid: null });
      return;
    }
    if (acceso.clave === 'kits') {
      setPantalla({ vista: 'kits_dispositivos' });
      return;
    }
    if (acceso.clave === 'llegadas') {
      setPantalla({ vista: 'llegadas_dispositivos' });
      return;
    }
    proximamente(acceso.titulo);
  };

  const proximamente = (titulo) => showAlert('Próximamente',
    `«${titulo}» va a estar disponible en una próxima versión de la app.`, [{ text: 'Entendido' }]);

  // ---- M3 · Recepción de kits ----
  // Con un solo dispositivo se entra directo a sus entregas, y «volver» desde ahí va al inicio.
  const elegirDispositivo = (dispositivo, { unico = false } = {}) => setPantalla({ vista: 'kits_entregas', dispositivo, unico });
  const verEntregas = () => setPantalla((actual) => ({ vista: 'kits_entregas', dispositivo: actual.dispositivo, unico: actual.unico }));
  // `sinEntrarDirecto`: se vuelve por un 404; con un solo dispositivo no se vuelve a entrar solo.
  const verDispositivos = ({ sinEntrarDirecto = false } = {}) => setPantalla({ vista: 'kits_dispositivos', sinEntrarDirecto });
  // 403 SIN_MODULO: emergenciaApi ya volvió a pedir el perfil; el inicio muestra los accesos nuevos.
  const sinModulo = (mensaje) => {
    setEnviando(false);
    showAlert('Sin permiso', mensaje, [{ text: 'Entendido' }]);
    setPantalla(INICIO);
  };
  const dispositivoNoEncontrado = () => {
    showToast({ type: 'warning', message: 'Ese dispositivo ya no está entre los tuyos. Se recargó la lista.' });
    verDispositivos({ sinEntrarDirecto: true });
  };
  // 'recibida' y 'conflicto' (409 de estado) vuelven a las entregas, que se recargan al montarse;
  // 'no_encontrada' (404) vuelve a «mis dispositivos».
  const terminarRecepcion = (motivo) => {
    setEnviando(false);
    if (motivo === 'no_encontrada') verDispositivos({ sinEntrarDirecto: true });
    else verEntregas();
  };

  // ---- M2 · Llegada de familias ----
  // `dispositivo` y `unico` viajan por todo el recorrido; `dni` es el último buscado (la recarga por
  // estado y «volver» lo conservan). `n` cambia para volver a montar una pantalla (recargarla).
  const verDispositivosLlegadas = ({ sinEntrarDirecto = false } = {}) => setPantalla({ vista: 'llegadas_dispositivos', sinEntrarDirecto });
  const verBuscar = ({ dni = '', autoBuscar = false } = {}) => setPantalla((actual) => ({
    vista: 'llegadas_buscar', dispositivo: actual.dispositivo, unico: actual.unico, dni, autoBuscar, n: (actual.n || 0) + 1,
  }));
  const elegirDispositivoLlegadas = (dispositivo, { unico = false } = {}) => setPantalla({ vista: 'llegadas_buscar', dispositivo, unico, dni: '', n: 1 });
  const verDerivacion = (busqueda) => setPantalla((actual) => ({ ...actual, vista: 'llegadas_derivacion', busqueda, dni: busqueda.dni || actual.dni }));
  const verIntegrantes = (caso, dni) => setPantalla((actual) => ({
    ...actual, vista: 'llegadas_integrantes', caso, dni: dni ?? actual.dni, n: (actual.n || 0) + 1, recargada: false,
  }));
  const llegadaNoEncontrada = () => {
    setEnviando(false);
    showToast({ type: 'warning', message: 'Eso ya no está entre lo tuyo. Se recargó la lista de tus dispositivos.' });
    verDispositivosLlegadas({ sinEntrarDirecto: true });
  };
  // El router de §13.1: ante un 409 se muestra `detail` y se recarga la pantalla de `estado_actual`.
  // DERIVADO vuelve a buscar sola por el DNI (trae la derivación vigente); INGRESO_EN_CURSO, ALOJADO y
  // CERRADO, a los integrantes (en lectura si ya está alojada); EN_GESTION, NUEVO y cualquier otro,
  // a buscar de nuevo: el caso volvió a la mesa.
  const recargarPorEstado = (clasificacion) => {
    setEnviando(false);
    showAlert('El caso cambió', clasificacion.mensaje, [{ text: 'Entendido' }]);
    setPantalla((actual) => {
      const caso = actual.caso || actual.busqueda?.derivacion?.caso || null;
      const base = { dispositivo: actual.dispositivo, unico: actual.unico, dni: actual.dni || '', n: (actual.n || 0) + 1 };
      // Guarda contra el bucle: si ya se recargó una vez esta misma pantalla de integrantes del mismo caso
      // por un 409, no se vuelve a montar: se busca de nuevo.
      const mismaRecargada = actual.vista === 'llegadas_integrantes' && actual.recargada && String(actual.caso?.id) === String(caso?.id);
      if (clasificacion.destino === 'integrantes' && caso && !mismaRecargada) {
        return { ...base, vista: 'llegadas_integrantes', caso, recargada: true };
      }
      if (clasificacion.destino === 'derivacion' && base.dni) return { ...base, vista: 'llegadas_buscar', autoBuscar: true };
      return { ...base, vista: 'llegadas_buscar', autoBuscar: false };
    });
  };

  const { vista, uuid } = pantalla;
  const titulo = vista === 'inicio' ? `Hola, ${displayName}`
    : (['kits_entregas', 'llegadas_buscar'].includes(vista) && pantalla.dispositivo?.nombre) || TITULOS[vista];
  const volver = () => {
    if (enviando) return;
    if (vista === 'formulario') setPantalla({ vista: 'envios', uuid: null });
    else if (vista === 'kits_recibir') verEntregas();
    else if (vista === 'kits_entregas' && !pantalla.unico) verDispositivos();
    else if (vista === 'llegadas_derivacion' || vista === 'llegadas_integrantes') verBuscar({ dni: pantalla.dni || '' });
    else if (vista === 'llegadas_buscar' && !pantalla.unico) verDispositivosLlegadas();
    else setPantalla(INICIO);
    refrescarEstado();
  };
  let syncStatus = 'synced';
  if (sincronizando || cargandoPerfil) syncStatus = 'syncing';
  else if (pendientes > 0) syncStatus = 'pending';

  return (
    <>
      <Banner title={titulo} syncStatus={syncStatus} syncPendingCount={pendientes}
        onSyncPress={sincronizarAhora} showBackButton={vista !== 'inicio' && !enviando} onBackPress={volver} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        {vista === 'inicio' ? (
          <EmergenciaInicioScreen onAbrir={abrir} recarga={recarga} onCargando={setCargandoPerfil} />
        ) : null}
        {vista === 'envios' ? (
          <EmergenciaMisEnviosScreen syncTick={syncTick} enviadosTick={enviadosTick} onCambio={refrescarEstado}
            onNuevo={relevarNueva}
            onCorregir={(abierto) => setPantalla({ vista: 'formulario', uuid: abierto })} />
        ) : null}
        {vista === 'formulario' ? (
          <EmergenciaFormulario1Screen key={uuid || 'nuevo'} uuid={uuid}
            onTerminar={() => { setPantalla({ vista: 'envios', uuid: null }); refrescarEstado(); }} />
        ) : null}
        {vista === 'kits_dispositivos' ? (
          <EmergenciaMisDispositivosScreen recarga={recarga} onElegir={elegirDispositivo} onSinModulo={sinModulo}
            entrarDirecto={!pantalla.sinEntrarDirecto} />
        ) : null}
        {vista === 'kits_entregas' ? (
          <EmergenciaEntregasScreen key={String(pantalla.dispositivo?.id)} dispositivo={pantalla.dispositivo} recarga={recarga}
            onAbrir={(entrega) => setPantalla((actual) => ({ ...actual, vista: 'kits_recibir', entrega }))}
            onNoEncontrado={dispositivoNoEncontrado} onSinModulo={sinModulo} />
        ) : null}
        {vista === 'kits_recibir' ? (
          <EmergenciaRecibirEntregaScreen key={String(pantalla.entrega?.id)} entrega={pantalla.entrega}
            dispositivoId={pantalla.dispositivo?.id ?? null} onTerminar={terminarRecepcion} onSinModulo={sinModulo}
            onEnviando={setEnviando} />
        ) : null}
        {vista === 'llegadas_dispositivos' ? (
          <EmergenciaMisDispositivosScreen key="llegadas" modo="llegadas" recarga={recarga} onElegir={elegirDispositivoLlegadas}
            onSinModulo={sinModulo} entrarDirecto={!pantalla.sinEntrarDirecto} />
        ) : null}
        {vista === 'llegadas_buscar' ? (
          <EmergenciaLlegadaBuscarScreen key={`buscar-${pantalla.dispositivo?.id}-${pantalla.n}`} dispositivo={pantalla.dispositivo}
            dniInicial={pantalla.dni} autoBuscar={!!pantalla.autoBuscar} esperaHasta={esperaBuscarHasta} onEspera={setEsperaBuscarHasta}
            onDerivacion={verDerivacion} onIntegrantes={verIntegrantes}
            onNoEncontrado={llegadaNoEncontrada} onSinModulo={sinModulo} onProximamente={proximamente} />
        ) : null}
        {vista === 'llegadas_derivacion' ? (
          <EmergenciaDerivacionScreen key={`derivacion-${pantalla.busqueda?.derivacion?.id}`} busqueda={pantalla.busqueda}
            onAceptada={(caso) => { setEnviando(false); verIntegrantes(caso); }}
            onRechazada={() => { setEnviando(false); verBuscar(); }}
            onConflicto={recargarPorEstado} onNoEncontrado={llegadaNoEncontrada} onSinModulo={sinModulo} onEnviando={setEnviando} />
        ) : null}
        {vista === 'llegadas_integrantes' ? (
          <EmergenciaIntegrantesScreen key={`integrantes-${pantalla.caso?.id}-${pantalla.n}`} caso={pantalla.caso} recarga={recarga}
            onConflicto={recargarPorEstado} onNoEncontrado={llegadaNoEncontrada} onSinModulo={sinModulo}
            onProximamente={proximamente} onEnviando={setEnviando} />
        ) : null}
      </View>
      {vista === 'inicio' ? (
        <View style={styles.barra}>
          <CustomButton title="Menú" variant="secondary" iconLeft="menu" onPress={() => setSettingsVisible(true)} />
        </View>
      ) : null}
      <SettingsPanel
        visible={!!settingsVisible}
        onClose={() => setSettingsVisible(false)}
        onCambiarModulo={onCambiarModulo && (() => {
          setSettingsVisible(false);
          onCambiarModulo();
        })}
        onLogout={salir}
      />
    </>
  );
}

const styles = StyleSheet.create({
  barra: { padding: 12, alignItems: 'center' },
});
