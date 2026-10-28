import React, { useState, useEffect, useRef } from 'react';
import { View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import HomeScreen from '../screens/HomeScreen';
import Banner from '../components/Banner';
import BottomNav from '../components/BottomNav';
import SettingsPanel from '../components/SettingsPanel';
import AvisosBandeja from '../components/AvisosBandeja';
import useAvisos from '../hooks/useAvisos';
import PageTransition from '../components/PageTransition';
import SkeletonLoader from '../components/SkeletonLoader';
import RelevamientosScreen from '../screens/RelevamientosScreen';
import RelevamientoDetailScreen from '../screens/RelevamientoDetailScreen';
import relevamientoService from '../services/relevamientoService';
import { resumenSyncManual } from '../utils/syncManual';

const NEW_RELEVAMIENTO_STATES = ['ASIGNADO'];

// Módulo Becas. Se monta solo con sesión y Becas activo: su sincronización de fondo y
// sus avisos no corren mientras se trabaja en otro módulo.
export default function BecasApp({ onCambiarModulo }) {
  const { showAlert, showToast } = useToast();
  const Alert = { alert: showAlert };
  const { user, logout } = useAuth();
  const displayName = user?.username || user?.nombre || 'Usuario';

  const [isPageLoading, setIsPageLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('Inicio');
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [selectedRelevamientoId, setSelectedRelevamientoId] = useState(null);
  const [avisosVisible, setAvisosVisible] = useState(false);

  // Avisos dentro de la app: un toast cuando entra uno nuevo con la app abierta.
  const avisos = useAvisos({
    activo: true,
    userId: user?.id,
    onNuevos: (creados) => showToast({
      type: 'info',
      title: creados.length === 1 ? creados[0].titulo : `Tenés ${creados.length} avisos nuevos`,
      message: creados.length === 1 ? creados[0].texto : 'Abrí Notificaciones para verlos.',
      duration: 6000,
    }),
  });

  const [syncStatus, setSyncStatus] = useState('synced');
  const [syncPendingCount, setSyncPendingCount] = useState(0);
  const [newRelevamientosCount, setNewRelevamientosCount] = useState(0);
  const [assignedRelevamientos, setAssignedRelevamientos] = useState([]);
  const lastConnectivityStateRef = useRef(null);
  const syncInProgressRef = useRef(false);
  const reconnectDebounceRef = useRef(null);

  const runBackgroundSync = async () => {
    if (syncInProgressRef.current) return;
    syncInProgressRef.current = true;
    try {
      await relevamientoService.syncPendingOperations();
    } catch {
      // Sin conectividad o error temporal: se mantiene en cola.
    } finally {
      syncInProgressRef.current = false;
      await refreshSyncStatus();
      // Sin await: los avisos nunca demoran ni cortan la sincronización.
      avisos.alSincronizar();
    }
  };

  const refreshSyncStatus = async () => {
    const pendingRelevamientos = await relevamientoService.getPendingCount();
    setSyncPendingCount(pendingRelevamientos);
    setSyncStatus(pendingRelevamientos > 0 ? 'pending' : 'synced');
  };

  const refreshNewRelevamientosCount = async () => {
    try {
      const result = await relevamientoService.getRelevamientos({ refreshFromRemote: true });
      avisos.alRefrescarRelevamientos(result);
      setAssignedRelevamientos(result.records || []);
      const nextCount = (result.records || []).filter((item) =>
        NEW_RELEVAMIENTO_STATES.includes(String(item.estado || '').toUpperCase())
      ).length;
      setNewRelevamientosCount(nextCount);
    } catch {
      setAssignedRelevamientos([]);
      setNewRelevamientosCount(0);
    }
  };

  useEffect(() => {
    runBackgroundSync();
    refreshNewRelevamientosCount();
    const timer = setInterval(async () => {
      await runBackgroundSync();
      await refreshNewRelevamientosCount();
    }, 8000);
    const unsubscribeNetInfo = NetInfo.addEventListener(async (state) => {
      const isConnected = !!state?.isConnected && state?.isInternetReachable !== false;
      const prev = lastConnectivityStateRef.current;
      lastConnectivityStateRef.current = isConnected;
      if (!prev && isConnected) {
        if (reconnectDebounceRef.current) {
          clearTimeout(reconnectDebounceRef.current);
        }
        reconnectDebounceRef.current = setTimeout(async () => {
          await runBackgroundSync();
          await refreshNewRelevamientosCount();
        }, 1800);
      }
    });

    return () => {
      clearInterval(timer);
      unsubscribeNetInfo?.();
      if (reconnectDebounceRef.current) {
        clearTimeout(reconnectDebounceRef.current);
      }
    };
  }, []);

  const handleTabPress = (tab) => {
    if (tab === activeTab) return;
    setIsPageLoading(true);
    setActiveTab(tab);
    // Simulate content loading for smooth feel
    setTimeout(() => {
      setIsPageLoading(false);
    }, 800);
  };

  const renderScreen = () => {
    if (isPageLoading) {
      return (
        <View style={{ flex: 1, padding: 20 }}>
          {/* Header Skeleton */}
          <SkeletonLoader height={40} width="60%" borderRadius={10} style={{ marginBottom: 30 }} delay={0} />

          {/* Content Block 1 */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 }}>
            <SkeletonLoader height={120} width="48%" borderRadius={20} delay={100} />
            <SkeletonLoader height={120} width="48%" borderRadius={20} delay={150} />
          </View>

          {/* Content Block 2 */}
          <SkeletonLoader height={180} borderRadius={25} style={{ marginBottom: 20 }} delay={200} />

          {/* Content Block 3 (Staggered list) */}
          <SkeletonLoader height={60} borderRadius={15} style={{ marginBottom: 12 }} delay={250} />
          <SkeletonLoader height={60} borderRadius={15} style={{ marginBottom: 12 }} delay={300} />
          <SkeletonLoader height={60} borderRadius={15} delay={350} />
        </View>
      );
    }

    switch (activeTab) {
      case 'Relevamientos':
        return (
          <RelevamientosScreen
            onOpenRelevamiento={(id) => setSelectedRelevamientoId(id)}
          />
        );
      default:
      return (
          <HomeScreen
            onOpenRelevamientos={() => handleTabPress('Relevamientos')}
            onOpenRelevamiento={(id) => setSelectedRelevamientoId(id)}
            onRefresh={handleHomeRefresh}
            assignedRelevamientos={assignedRelevamientos}
          />
        );
    }
  };

  const abrirAviso = async (aviso) => {
    await avisos.leer(aviso);
    setAvisosVisible(false);
    if (aviso.relevamiento_id) {
      const id = String(aviso.relevamiento_id);
      setSelectedRelevamientoId(/^\d+$/.test(id) ? Number(id) : id);
    }
  };

  const handleManualSync = async () => {
    if (syncInProgressRef.current) return;

    try {
      syncInProgressRef.current = true;
      setSyncStatus('syncing');
      const relevamientoResult = await relevamientoService.retryFailedOperations();

      await refreshSyncStatus();

      const { title, message } = resumenSyncManual(relevamientoResult);
      Alert.alert(title, message);
    } catch (error) {
      setSyncStatus('pending');
      Alert.alert('Sincronizacion', error?.message || 'No se pudo sincronizar.');
    } finally {
      syncInProgressRef.current = false;
      await refreshSyncStatus();
      avisos.alSincronizar();
    }
  };

  const handleHomeRefresh = async () => {
    await runBackgroundSync();
    await refreshNewRelevamientosCount();
    await refreshSyncStatus();
  };

  return (
    <>
      <View style={{ flex: 1 }}>
        {selectedRelevamientoId ? (
          <RelevamientoDetailScreen
            relevamientoId={selectedRelevamientoId}
            onClose={() => {
              setSelectedRelevamientoId(null);
              refreshNewRelevamientosCount();
            }}
            syncStatus={syncStatus}
            syncPendingCount={syncPendingCount}
            onSyncPress={handleManualSync}
          />
        ) : (
          <>
            <Banner
              title={activeTab === 'Inicio' ? `Hola, ${displayName}` : activeTab}
              syncStatus={syncStatus}
              syncPendingCount={syncPendingCount}
              onSyncPress={handleManualSync}
              showBackButton={activeTab !== 'Inicio'}
              onBackPress={() => handleTabPress('Inicio')}
              preserveTitleCase={activeTab === 'Inicio'}
            />

            <View style={{ flex: 1 }}>
              <PageTransition activeTab={activeTab}>
                {renderScreen()}
              </PageTransition>
            </View>

            <BottomNav
              activeTab={activeTab}
              onTabPress={handleTabPress}
              onOpenSettings={() => setSettingsVisible(true)}
              pendingCount={newRelevamientosCount}
              avisosCount={avisos.noLeidos}
            />
          </>
        )}
      </View>

      {/* Settings Panel is always ready but hidden */}
      <SettingsPanel
        visible={!!settingsVisible}
        onClose={() => setSettingsVisible(false)}
        avisosNoLeidos={avisos.noLeidos}
        onOpenAvisos={() => {
          setSettingsVisible(false);
          setAvisosVisible(true);
        }}
        onCambiarModulo={onCambiarModulo && (() => {
          setSettingsVisible(false);
          setAvisosVisible(false);
          onCambiarModulo();
        })}
        onLogout={() => {
          setSettingsVisible(false);
          setAvisosVisible(false);
          logout();
          setActiveTab('Inicio');
          setSelectedRelevamientoId(null);
        }}
      />
      <AvisosBandeja
        visible={avisosVisible}
        avisos={avisos.avisos}
        noLeidos={avisos.noLeidos}
        onClose={() => setAvisosVisible(false)}
        onPressAviso={abrirAviso}
        onMarcarTodo={avisos.leerTodo}
      />
    </>
  );
}
