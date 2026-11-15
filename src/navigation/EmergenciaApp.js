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
import {
  descartar, getBorradorEnCurso, getLocalidadesGuardadas, getPendingCount, getResumenPendientes, reintentar, syncPendientes,
} from '../services/emergenciaCola';
import { avisoDeSalida } from '../utils/emergencia';

const SYNC_INTERVAL_MS = 8000;
const RECONNECT_DELAY_MS = 1800;

const TITULOS = { envios: 'Ingreso de familias', formulario: 'Relevar una familia' };

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
// el Formulario 1). Como Dispositivos, no importa nada de los otros módulos: comparte sesión, tema
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
    if (pantalla.vista === 'inicio') setRecarga((valor) => valor + 1);
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
      } else if (pantalla.vista !== 'inicio') {
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
    showAlert('Próximamente',
      `«${acceso.titulo}» va a estar disponible en una próxima versión de la app.`, [{ text: 'Entendido' }]);
  };

  const { vista, uuid } = pantalla;
  const titulo = vista === 'inicio' ? `Hola, ${displayName}` : TITULOS[vista];
  const volver = () => {
    setPantalla(vista === 'formulario' ? { vista: 'envios', uuid: null } : { vista: 'inicio', uuid: null });
    refrescarEstado();
  };
  let syncStatus = 'synced';
  if (sincronizando || cargandoPerfil) syncStatus = 'syncing';
  else if (pendientes > 0) syncStatus = 'pending';

  return (
    <>
      <Banner title={titulo} syncStatus={syncStatus} syncPendingCount={pendientes}
        onSyncPress={sincronizarAhora} showBackButton={vista !== 'inicio'} onBackPress={volver} />
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
