import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import Banner from '../components/Banner';
import CustomButton from '../components/CustomButton';
import SettingsPanel from '../components/SettingsPanel';
import DispositivosListaScreen from '../screens/DispositivosListaScreen';
import DispositivoDetalleScreen from '../screens/DispositivoDetalleScreen';
import DispositivoCompletarScreen from '../screens/DispositivoCompletarScreen';
import { getPendingCount, syncPendientes, reintentarFallidas } from '../services/dispositivosService';

const SYNC_INTERVAL_MS = 8000;
const RECONNECT_DELAY_MS = 1800;

// Módulo Dispositivos: lista -> detalle -> completar. No importa nada de Becas: comparte solo
// sesión, tema y componentes genéricos. Se monta con sesión y módulo activo, así su
// sincronización de fondo no corre mientras se trabaja en otro módulo.
export default function DispositivosApp({ onCambiarModulo }) {
  const { theme } = useTheme();
  const { showAlert, showToast } = useToast();
  const { user, logout } = useAuth();
  const displayName = user?.username || user?.nombre || 'Usuario';
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [pantalla, setPantalla] = useState({ vista: 'lista', id: null });
  const [syncStatus, setSyncStatus] = useState('synced');
  const [syncPendingCount, setSyncPendingCount] = useState(0);
  const [syncTick, setSyncTick] = useState(0);
  const enCurso = useRef(false);
  const conectado = useRef(null);
  const reconexion = useRef(null);
  const montado = useRef(true);

  const refrescarEstado = async () => {
    try {
      const pendientes = await getPendingCount();
      if (!montado.current) return;
      setSyncPendingCount(pendientes);
      setSyncStatus(pendientes > 0 ? 'pending' : 'synced');
      setSyncTick((tick) => tick + 1);
    } catch {
      // Sin base local legible: se deja el estado anterior.
    }
  };

  const sincronizarDeFondo = async () => {
    if (enCurso.current) return;
    enCurso.current = true;
    try {
      await syncPendientes();
    } catch {
      // Sin conexión o error temporal: queda en cola.
    } finally {
      enCurso.current = false;
      await refrescarEstado();
    }
  };

  useEffect(() => {
    montado.current = true;
    sincronizarDeFondo();
    const timer = setInterval(sincronizarDeFondo, SYNC_INTERVAL_MS);
    const desuscribir = NetInfo.addEventListener((state) => {
      const hayRed = !!state?.isConnected && state?.isInternetReachable !== false;
      const antes = conectado.current;
      conectado.current = hayRed;
      if (!antes && hayRed) {
        if (reconexion.current) clearTimeout(reconexion.current);
        reconexion.current = setTimeout(sincronizarDeFondo, RECONNECT_DELAY_MS);
      }
    });
    return () => {
      montado.current = false;
      clearInterval(timer);
      desuscribir?.();
      if (reconexion.current) clearTimeout(reconexion.current);
    };
  }, []);

  const sincronizarAhora = async () => {
    if (enCurso.current) return;
    enCurso.current = true;
    setSyncStatus('syncing');
    try {
      const result = await reintentarFallidas();
      if (result?.offline) showToast({ type: 'warning', message: 'Sin conexión. Se envía solo cuando vuelva.' });
      else if (result?.failed > 0) showToast({ type: 'warning', message: `No se pudo enviar ${result.failed}. Mirá el detalle del relevamiento.` });
      else if (result?.synced > 0) showToast({ type: 'success', message: `Se enviaron ${result.synced}.` });
      else showToast({ type: 'info', message: 'No había nada para enviar.' });
    } catch (error) {
      showToast({ type: 'error', message: error?.message || 'No se pudo sincronizar.' });
    } finally {
      enCurso.current = false;
      await refrescarEstado();
    }
  };

  const salir = async () => {
    setSettingsVisible(false);
    let pendientes = 0;
    try {
      pendientes = await getPendingCount();
    } catch {
      pendientes = 0;
    }
    if (pendientes > 0) {
      showAlert('Cerrar sesión',
        `Tenés ${pendientes} envíos sin sincronizar; se van a enviar cuando vuelvas a entrar con este usuario.`, [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Salir', style: 'destructive', onPress: () => logout() },
        ]);
      return;
    }
    logout();
  };

  const { vista, id } = pantalla;
  const titulo = vista === 'lista' ? `Hola, ${displayName}` : vista === 'detalle' ? 'Relevamiento' : 'Completar relevamiento';
  const volver = () => setPantalla(vista === 'completar' ? { vista: 'detalle', id } : { vista: 'lista', id: null });

  return (
    <>
      <Banner title={titulo} syncStatus={syncStatus} syncPendingCount={syncPendingCount}
        onSyncPress={sincronizarAhora} showBackButton={vista !== 'lista'} onBackPress={volver} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        {vista === 'lista' ? (
          <DispositivosListaScreen syncTick={syncTick} onAbrir={(abierto) => setPantalla({ vista: 'detalle', id: abierto })} />
        ) : null}
        {vista === 'detalle' ? (
          <DispositivoDetalleScreen inspeccionId={id} syncTick={syncTick}
            onCompletar={(abierto) => setPantalla({ vista: 'completar', id: abierto })} />
        ) : null}
        {vista === 'completar' ? (
          <DispositivoCompletarScreen inspeccionId={id} onTerminar={() => { setPantalla({ vista: 'lista', id: null }); refrescarEstado(); }} />
        ) : null}
      </View>
      {vista === 'lista' ? (
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
