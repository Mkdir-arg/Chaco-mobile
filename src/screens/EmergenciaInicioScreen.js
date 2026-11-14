import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { statusTones } from '../theme/statusBadges';
import CustomButton from '../components/CustomButton';
import { accesosDelPerfil, cargarPerfil, getPerfilGuardado, subscribePerfil } from '../services/emergenciaPerfil';
import { fontSizes, radii } from '../theme';

export const SIN_TAREAS = 'No tenés tareas en la app. Pedí que te sumen al equipo de un dispositivo.';

// Pantalla inicial de Emergencia: los accesos que habilita el perfil. Arranca con el perfil
// guardado (si hay) y lo actualiza con el del back. `recarga` cambia cuando se pide volver a
// consultarlo (botón de sincronizar del Banner).
export default function EmergenciaInicioScreen({ onAbrir, recarga = 0 }) {
  const { theme, typography } = useTheme();
  const [perfil, setPerfil] = useState(null);
  const [desdeCache, setDesdeCache] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const montado = useRef(true);

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (silencioso) setRefreshing(true);
    try {
      const resultado = await cargarPerfil();
      if (!montado.current) return;
      setPerfil(resultado.perfil);
      setDesdeCache(resultado.desdeCache);
      setError('');
    } catch (e) {
      if (!montado.current) return;
      setError(e?.message || 'No se pudo cargar tu perfil.');
    } finally {
      if (montado.current) {
        setLoading(false);
        setRefreshing(false);
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
      <Ionicons name={icono} size={18} color={statusTones[tono].tx} />
      <Text style={[styles.avisoText, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{texto}</Text>
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => cargar({ silencioso: true })}
        colors={[theme.colors.primary]} tintColor={theme.colors.primary} />}>
      <Text style={[styles.title, { color: theme.colors.text, fontFamily: typography.bold }]}>Emergencia</Text>

      {perfil && desdeCache ? aviso('warning', 'cloud-offline-outline', 'Sin conexión: se muestran tus accesos guardados.') : null}
      {error ? aviso('danger', 'alert-circle-outline', error) : null}

      {loading && !perfil ? (
        <View style={styles.centro}><ActivityIndicator size="large" color={theme.colors.primary} /></View>
      ) : null}

      {accesos.map((acceso) => (
        <Pressable key={acceso.clave} accessibilityRole="button" accessibilityLabel={acceso.titulo}
          onPress={() => onAbrir && onAbrir(acceso)}
          style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Ionicons name={acceso.icono} size={26} color={theme.colors.primary} />
          <Text style={[styles.cardTitle, { color: theme.colors.text, fontFamily: typography.bold }]}>{acceso.titulo}</Text>
          <Ionicons name="chevron-forward" size={20} color={theme.colors.textSoft} />
        </Pressable>
      ))}

      {perfil && !accesos.length ? (
        <View style={styles.centro}>
          <Ionicons name="file-tray-outline" size={30} color={theme.colors.textSoft} />
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
  cardTitle: { flex: 1, fontSize: fontSizes.base },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10, marginBottom: 12 },
  avisoText: { flex: 1, fontSize: fontSizes.xs },
  centro: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  vacio: { fontSize: fontSizes.sm, textAlign: 'center' },
});
