import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { statusTones } from '../theme/statusBadges';
import CustomButton from '../components/CustomButton';
import { accesosDelPerfil, cargarPerfil, getPerfilGuardado, subscribePerfil } from '../services/emergenciaPerfil';
import { fontSizes, radii } from '../theme';

export const SIN_TAREAS = 'No tenés tareas en la app. Pedí que te sumen al equipo de un dispositivo.';
export const AVISO_SIN_RED = 'Sin conexión: se muestran tus accesos guardados.';
export const AVISO_DESACTUALIZADO = 'No se pudo actualizar: se muestran tus accesos guardados.';

// Pantalla inicial de Emergencia: los accesos que habilita el perfil. Arranca con el perfil
// guardado (si hay) y lo actualiza con el del back. `recarga` cambia cuando se pide volver a
// consultarlo (botón de sincronizar del Banner); `onCargando` avisa cuándo hay un pedido en curso,
// para que el Banner lo muestre (RN Web no dibuja el RefreshControl).
export default function EmergenciaInicioScreen({ onAbrir, recarga = 0, onCargando }) {
  const { theme, typography } = useTheme();
  const [perfil, setPerfil] = useState(null);
  const [desdeCache, setDesdeCache] = useState(false);
  const [sinRed, setSinRed] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const montado = useRef(true);
  const onCargandoRef = useRef(onCargando);
  onCargandoRef.current = onCargando;
  const avisarCargando = (valor) => { if (onCargandoRef.current) onCargandoRef.current(valor); };

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (silencioso) setRefreshing(true);
    avisarCargando(true);
    try {
      const resultado = await cargarPerfil();
      if (!montado.current) return;
      setPerfil(resultado.perfil);
      setDesdeCache(resultado.desdeCache);
      setSinRed(!!resultado.sinRed);
      setError('');
    } catch (e) {
      // Pedido de una sesión anterior: la pantalla de la sesión nueva pide el suyo.
      if (!montado.current || e?.obsoleto) return;
      setError(e?.message || 'No se pudo cargar tu perfil.');
    } finally {
      if (montado.current) {
        setLoading(false);
        setRefreshing(false);
        avisarCargando(false);
      }
    }
  }, []);

  useEffect(() => {
    montado.current = true;
    // Lo guardado se muestra mientras llega la respuesta del back.
    getPerfilGuardado().then((guardado) => {
      if (montado.current && guardado) setPerfil((actual) => actual || guardado);
    });
    const desuscribir = subscribePerfil((nuevo) => {
      if (!montado.current) return;
      setPerfil(nuevo);
      setDesdeCache(false);
      setSinRed(false);
      setError('');
    });
    cargar();
    return () => {
      montado.current = false;
      desuscribir();
    };
  }, [cargar]);

  useEffect(() => { if (recarga) cargar({ silencioso: true }); }, [recarga, cargar]);

  const accesos = accesosDelPerfil(perfil);

  const aviso = (tono, icono, texto) => (
    <View style={[styles.aviso, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      <Ionicons name={icono} size={18} color={statusTones[tono].tx} accessible={false} importantForAccessibility="no" />
      <Text style={[styles.avisoText, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{texto}</Text>
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => cargar({ silencioso: true })}
        colors={[theme.colors.primary]} tintColor={theme.colors.primary} />}>
      <Text accessibilityRole="header" style={[styles.title, { color: theme.colors.text, fontFamily: typography.bold }]}>Emergencia</Text>

      {perfil && desdeCache ? (sinRed
        ? aviso('warning', 'cloud-offline-outline', AVISO_SIN_RED)
        : aviso('warning', 'information-circle-outline', AVISO_DESACTUALIZADO)) : null}
      {error ? aviso('danger', 'alert-circle-outline', error) : null}

      {refreshing && Platform.OS === 'web' ? (
        <ActivityIndicator style={styles.recargando} color={theme.colors.primary}
          accessibilityLabel="Actualizando tus accesos" />
      ) : null}

      {loading && !perfil ? (
        <View style={styles.centro}><ActivityIndicator size="large" color={theme.colors.primary} /></View>
      ) : null}

      {accesos.map((acceso) => (
        <Pressable key={acceso.clave} accessibilityRole="button" accessibilityLabel={acceso.titulo}
          onPress={() => onAbrir && onAbrir(acceso)}
          style={({ pressed }) => [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            pressed && styles.cardPressed]}>
          <Ionicons name={acceso.icono} size={26} color={theme.colors.primary} accessible={false} importantForAccessibility="no" />
          <Text style={[styles.cardTitle, { color: theme.colors.text, fontFamily: typography.bold }]}>{acceso.titulo}</Text>
          <Ionicons name="chevron-forward" size={20} color={theme.colors.textSoft} accessible={false} importantForAccessibility="no" />
        </Pressable>
      ))}

      {perfil && !accesos.length ? (
        <View style={styles.centro}>
          <Ionicons name="file-tray-outline" size={30} color={theme.colors.textSoft} accessible={false} importantForAccessibility="no" />
          <Text style={[styles.vacio, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>{SIN_TAREAS}</Text>
        </View>
      ) : null}

      {!loading && !perfil ? (
        <CustomButton title="Reintentar" variant="secondary" iconLeft="refresh" onPress={() => cargar({ silencioso: true })} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32 },
  title: { fontSize: fontSizes.xl, marginBottom: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: radii.xl, padding: 16, marginBottom: 10 },
  cardPressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  cardTitle: { flex: 1, fontSize: fontSizes.base },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10, marginBottom: 12 },
  avisoText: { flex: 1, fontSize: fontSizes.xs },
  centro: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  recargando: { marginBottom: 12 },
  vacio: { fontSize: fontSizes.sm, textAlign: 'center' },
});
