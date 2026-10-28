import React, { useState, useEffect } from 'react';
import { View, StyleSheet, StatusBar, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts, Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold } from '@expo-google-fonts/manrope';
import * as ScreenOrientation from 'expo-screen-orientation';

import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { ToastProvider } from './src/context/ToastContext';
import SplashScreen from './src/screens/SplashScreen';
import LoginScreen from './src/screens/LoginScreen';
import ModuloSelectorScreen from './src/screens/ModuloSelectorScreen';
import BecasApp from './src/navigation/BecasApp';
import DispositivosApp from './src/navigation/DispositivosApp';
import { requiereActualizacionGuardada, versionActual } from './src/services/versionApp';
import { getStoredBecasUser } from './src/services/becasApi';
import { evaluarBloqueoVersion } from './src/navigation/bloqueoVersion';
import ActualizarAppScreen from './src/components/ActualizarAppScreen';

let hasBootstrappedOnce = false;

function AppContent() {
  const { theme, isDark } = useTheme();
  const { user, isAuthenticated, loading: authLoading, logout, modulos, moduloActivo, elegirModulo } = useAuth();
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  const [isLoading, setIsLoading] = useState(!hasBootstrappedOnce);
  const [bloqueoVersion, setBloqueoVersion] = useState(null);

  useEffect(() => {
    if (fontsLoaded && !authLoading) {
      if (hasBootstrappedOnce) {
        setIsLoading(false);
        return;
      }
      const timer = setTimeout(() => {
        hasBootstrappedOnce = true;
        setIsLoading(false);
      }, 1450);
      return () => clearTimeout(timer);
    }
  }, [fontsLoaded, authLoading]);

  useEffect(() => {
    const lockPortrait = async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT);
      } catch {
        // En algunos entornos (web/simulator) puede no aplicar; no es bloqueante.
      }
    };

    lockPortrait();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') lockPortrait();
    });
    return () => {
      sub?.remove?.();
    };
  }, []);

  // Tras el login y en cada arranque con sesión: si el back pide una versión mínima mayor
  // a la instalada, se bloquea con «Actualizá la app». Sin dato o con error, entra normal.
  useEffect(() => {
    let vigente = true;
    if (!isAuthenticated) { setBloqueoVersion(null); return undefined; }
    evaluarBloqueoVersion({ requiereActualizacionGuardada, versionActual, getStoredUser: getStoredBecasUser })
      .then((bloqueo) => { if (vigente) setBloqueoVersion(bloqueo); });
    return () => { vigente = false; };
  }, [isAuthenticated, user?.id]);

  if (isLoading || !fontsLoaded) {
    return <SplashScreen />;
  }

  // Cada módulo es un árbol aparte: al cambiar de módulo el anterior se desmonta y
  // con él sus pantallas, su estado y su sincronización de fondo.
  const onCambiarModulo = modulos.length > 1 ? () => elegirModulo(null) : null;
  const renderModulo = () => {
    if (!isAuthenticated) return <LoginScreen />;
    if (bloqueoVersion) return (
      <ActualizarAppScreen
        actual={bloqueoVersion.actual}
        minima={bloqueoVersion.minima}
        onLogout={logout}
      />
    );
    if (moduloActivo === 'becas') return <BecasApp onCambiarModulo={onCambiarModulo} />;
    if (moduloActivo === 'dispositivos') return <DispositivosApp onCambiarModulo={onCambiarModulo} />;
    return <ModuloSelectorScreen />;
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      {renderModulo()}
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <ThemeProvider>
            <ToastProvider>
              <AppContent />
            </ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
