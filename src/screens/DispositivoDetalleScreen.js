import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Linking, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import CustomButton from '../components/CustomButton';
import { statusTones } from '../theme/statusBadges';
import { getInspeccion, reintentarFallidas, descartarEnvio } from '../services/dispositivosService';
import { direccionDe, mapaUrl, describirEnvio, etiquetasDeCampos, textoEnEspera, ETIQUETA_ENVIO } from '../utils/dispositivos';
import { formatDate } from '../utils/dates';
import { fontSizes, radii } from '../theme';

const TONO_ENVIO = { pendiente: 'warning', en_cola: 'info', error: 'danger', enviado: 'success' };
const ESTADO = { ASIGNADA: 'Asignada', EN_CURSO: 'En curso', REALIZADA: 'Realizada', CANCELADA: 'Cancelada' };

export default function DispositivoDetalleScreen({ inspeccionId, onCompletar, onSalir, syncTick = 0 }) {
  const { theme, typography } = useTheme();
  const { showToast, showAlert } = useToast();
  const [detalle, setDetalle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reintentando, setReintentando] = useState(false);

  const cargar = useCallback(async (remoto = true) => {
    try {
      const result = await getInspeccion(inspeccionId, { refreshFromRemote: remoto });
      if (result) { setDetalle(result); setError(''); }
      else setError('No se pudo cargar el relevamiento. Revisá la conexión e intentá de nuevo.');
    } catch (e) {
      setError(e?.message || 'No se pudo cargar el relevamiento.');
    } finally {
      setLoading(false);
    }
  }, [inspeccionId]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { if (syncTick) cargar(false); }, [syncTick, cargar]);

  const envio = detalle?.envio || null;
  // El formulario que bajó ahora no es el que se usó al cargar: los campos nuevos faltan.
  const formularioCambio = envio?.version_capturada != null && detalle?.formulario?.version != null
    && Number(envio.version_capturada) !== Number(detalle.formulario.version);
  const motivo = useMemo(
    () => describirEnvio(envio, etiquetasDeCampos(detalle?.formulario), { formularioCambio }),
    [envio, detalle, formularioCambio]);
  const cerrada = ['REALIZADA', 'CANCELADA'].includes(String(detalle?.estado || '').toUpperCase());
  const puedeCompletar = !!detalle && !detalle.sin_detalle && !cerrada
    && (!envio || (envio.estado === 'error' && !envio.descartada && envio.code !== 'ARCHIVO_RECHAZADO'));

  const reintentar = async () => {
    setReintentando(true);
    try {
      await reintentarFallidas(inspeccionId);
      await cargar(false);
    } catch (e) {
      showToast({ type: 'error', message: e?.message || 'No se pudo reintentar el envío.' });
    } finally {
      setReintentando(false);
    }
  };

  const descartar = () => showAlert(
    'Descartar lo cargado',
    'Se borra del teléfono lo que cargaste en este relevamiento, fotos incluidas. No se puede deshacer.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Descartar',
        style: 'destructive',
        onPress: async () => {
          try {
            await descartarEnvio(inspeccionId);
            if (onSalir) onSalir();
          } catch (e) {
            showToast({ type: 'error', message: e?.message || 'No se pudo descartar.' });
          }
        },
      },
    ]);

  const abrirMapa = async () => {
    try {
      await Linking.openURL(mapaUrl(detalle.edificio));
    } catch {
      showToast({ type: 'error', message: 'No se pudo abrir el mapa.' });
    }
  };

  if (loading) return <View style={styles.centro}><ActivityIndicator size="large" color={theme.colors.primary} /></View>;
  if (!detalle) {
    return (
      <View style={styles.centro}>
        <Text style={[styles.valor, { color: theme.colors.text, fontFamily: typography.medium }]}>{error}</Text>
        <CustomButton title="Reintentar" variant="secondary" onPress={() => { setLoading(true); cargar(); }} />
      </View>
    );
  }

  const edificio = detalle.edificio || {};
  const direccion = direccionDe(edificio);
  const url = mapaUrl(edificio);
  const tono = envio ? statusTones[TONO_ENVIO[envio.estado] || 'gray'] : null;
  const fila = (titulo, valor) => valor ? (
    <View style={styles.fila}>
      <Text style={[styles.etiqueta, { color: theme.colors.textSoft, fontFamily: typography.semibold }]}>{titulo}</Text>
      <Text style={[styles.valor, { color: theme.colors.text, fontFamily: typography.medium }]}>{valor}</Text>
    </View>
  ) : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}>
      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <Text style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{edificio.nombre || `Relevamiento ${detalle.id}`}</Text>
        {fila('Código', edificio.codigo)}
        {fila('Dirección', direccion)}
        {url ? (
          <Pressable accessibilityRole="link" onPress={abrirMapa} style={styles.mapa}>
            <Ionicons name="map-outline" size={18} color={theme.colors.primary} />
            <Text style={[styles.valor, { color: theme.colors.primary, fontFamily: typography.bold }]}>Ver en el mapa</Text>
          </Pressable>
        ) : null}
        {fila('Indicaciones', detalle.indicaciones)}
        {fila('Vencimiento', detalle.fecha_vencimiento ? `${formatDate(detalle.fecha_vencimiento)}${detalle.vencida ? ' (vencido)' : ''}` : '')}
        {fila('Estado', ESTADO[detalle.estado] || detalle.estado)}
      </View>

      {envio ? (
        <View style={[styles.card, { backgroundColor: tono.bg, borderColor: tono.bd }]}>
          <Text style={[styles.titulo, { color: tono.tx, fontFamily: typography.bold }]}>{`Envío: ${ETIQUETA_ENVIO[envio.estado] || envio.estado}`}</Text>
          {motivo ? (
            <>
              <Text accessibilityRole="alert" style={[styles.valor, { color: tono.tx, fontFamily: typography.semibold }]}>{motivo.titulo}</Text>
              {motivo.detalle ? <Text style={[styles.valor, { color: tono.tx, fontFamily: typography.medium }]}>{motivo.detalle}</Text> : null}
              {motivo.claves.map((item) => (
                <Text key={item.clave} style={[styles.valor, { color: tono.tx, fontFamily: typography.medium }]}>
                  {item.texto}
                </Text>
              ))}
              {!motivo.sinReintento ? (
                <CustomButton title="Reintentar envío" variant="secondary" iconLeft="refresh" loading={reintentando}
                  disabled={reintentando} onPress={reintentar} />
              ) : null}
              {envio.permanente ? (
                <CustomButton title="Descartar lo cargado" variant="secondary" iconLeft="trash-outline" onPress={descartar} />
              ) : null}
            </>
          ) : (
            <Text style={[styles.valor, { color: tono.tx, fontFamily: typography.medium }]}>
              {envio.estado === 'enviado' ? 'El resultado ya se registró.' : textoEnEspera(envio)}
            </Text>
          )}
        </View>
      ) : null}

      {puedeCompletar ? (
        <CustomButton title="Completar relevamiento" iconLeft="create-outline" size="L" onPress={() => onCompletar && onCompletar(detalle.id)} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 8 },
  titulo: { fontSize: fontSizes.base },
  fila: { gap: 2 },
  etiqueta: { fontSize: fontSizes.xs },
  valor: { fontSize: fontSizes.sm },
  mapa: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
