import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, Modal, PanResponder, Platform, ScrollView } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../FormInput';
import { useTheme } from '../../context/ThemeContext';
import { fontSizes, radii } from '../../theme';
import { errorFirma, firmanteDe, DNI_FIRMANTE, soloDigitos } from '../../services/definicionFormulario';
import { ALTO_FIRMA, ANCHO_FIRMA, COLOR_TRAZO, GROSOR_TRAZO, generarPngFirma, trazoAPath } from './firmaPng';

export const textoFirmante = (value) => {
  const { nombre, dni } = firmanteDe(value);
  return `Firmó: ${nombre || '-'} · DNI ${dni || '-'}`;
};

// Miniatura de la firma y quién firmó. La usan el campo y los resúmenes de las pantallas.
export function ResumenFirma({ value, onVer }) {
  const { theme, typography } = useTheme();
  const uri = value?.uri || value?.dataUri;
  return (
    <View style={styles.resumen}>
      {uri ? (
        <TouchableOpacity activeOpacity={0.86} disabled={!onVer} onPress={onVer}
          accessibilityLabel="Ver la firma" style={[styles.miniatura, { borderColor: theme.colors.border }]}>
          <Image source={{ uri }} style={styles.miniaturaImagen} resizeMode="contain" />
        </TouchableOpacity>
      ) : null}
      <Text style={[styles.firmante, { color: theme.colors.text, fontFamily: typography.medium }]}>{textoFirmante(value)}</Text>
    </View>
  );
}

const limitar = (valor, maximo) => Math.max(0, Math.min(maximo || 0, Number(valor) || 0));

// Recuadro de firma con el dedo o el mouse: PanResponder anda igual en nativo y en web.
function PadFirma({ trazos, onTrazos, svgRef, tam }) {
  const { theme } = useTheme();
  const padRef = useRef(null);
  const actual = useRef(null);
  const origenWeb = useRef(null);
  const [, redibujar] = useState(0);
  const trazosRef = useRef(trazos);
  trazosRef.current = trazos;

  // En web el destino del evento puede cambiar al arrastrar fuera del recuadro: la posición se
  // calcula contra el recuadro tomado al empezar, no contra el elemento tocado.
  const punto = (evt) => {
    const { locationX, locationY, pageX, pageY } = evt.nativeEvent;
    let x = locationX;
    let y = locationY;
    if (Platform.OS === 'web' && origenWeb.current && pageX != null) {
      x = pageX - origenWeb.current.x;
      y = pageY - origenWeb.current.y;
    }
    return { x: Math.round(limitar(x, tam.current.ancho) * 10) / 10, y: Math.round(limitar(y, tam.current.alto) * 10) / 10 };
  };

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: (evt) => {
      if (Platform.OS === 'web' && padRef.current?.getBoundingClientRect) {
        const rect = padRef.current.getBoundingClientRect();
        origenWeb.current = { x: rect.left + (globalThis.scrollX || 0), y: rect.top + (globalThis.scrollY || 0) };
      }
      actual.current = [punto(evt)];
      redibujar((n) => n + 1);
    },
    onPanResponderMove: (evt) => {
      if (!actual.current) return;
      actual.current = [...actual.current, punto(evt)];
      redibujar((n) => n + 1);
    },
    onPanResponderRelease: () => {
      if (actual.current?.length) onTrazos([...trazosRef.current, actual.current]);
      actual.current = null;
      redibujar((n) => n + 1);
    },
    onPanResponderTerminate: () => {
      if (actual.current?.length) onTrazos([...trazosRef.current, actual.current]);
      actual.current = null;
      redibujar((n) => n + 1);
    },
  })).current;

  const ancho = tam.current.ancho || ANCHO_FIRMA;
  const alto = tam.current.alto || ALTO_FIRMA;
  const todos = actual.current ? [...trazos, actual.current] : trazos;
  return (
    <View ref={padRef} {...responder.panHandlers} accessibilityLabel="Recuadro de firma"
      testID="pad-firma"
      onLayout={(e) => {
        tam.current = { ancho: e.nativeEvent.layout.width, alto: e.nativeEvent.layout.height };
        redibujar((n) => n + 1);
      }}
      style={[styles.pad, { borderColor: theme.colors.border }, Platform.OS === 'web' && styles.padWeb]}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${ancho} ${alto}`} preserveAspectRatio="none">
          <Rect x="0" y="0" width={ancho} height={alto} fill="#FFFFFF" />
          {todos.map((trazo, index) => (
            <Path key={index} d={trazoAPath(trazo)} stroke={COLOR_TRAZO} strokeWidth={GROSOR_TRAZO}
              fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </Svg>
      </View>
      {!todos.length ? (
        <View pointerEvents="none" style={styles.padGuia}>
          <Text style={{ color: '#6B7280', fontSize: fontSizes.xs }}>Firmá acá</Text>
        </View>
      ) : null}
    </View>
  );
}

function ModalFirma({ field, inicial, onCancelar, onConfirmar }) {
  const { theme, typography } = useTheme();
  const [trazos, setTrazos] = useState([]);
  const [nombre, setNombre] = useState(inicial.nombre || '');
  const [dni, setDni] = useState(inicial.dni || '');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const svgRef = useRef(null);
  const tam = useRef({ ancho: 0, alto: 0 });

  const confirmar = async () => {
    if (guardando) return;
    const nombreLimpio = nombre.trim();
    let motivo = '';
    if (!trazos.length) motivo = 'Firmá en el recuadro.';
    else if (!nombreLimpio) motivo = 'Completá el nombre y apellido de quien firma.';
    else if (!DNI_FIRMANTE.test(dni)) motivo = 'Ingresá un DNI válido de 7 u 8 dígitos.';
    setError(motivo);
    if (motivo) return;
    setGuardando(true);
    try {
      const item = await generarPngFirma({ trazos, ancho: tam.current.ancho, alto: tam.current.alto,
        svg: svgRef.current, clave: field.clave || field.original_id || field.id });
      await onConfirmar({ ...item, firmante: { nombre: nombreLimpio, dni } });
    } catch (e) {
      setError(e?.message || 'No se pudo guardar la firma.');
      setGuardando(false);
    }
  };

  const input = [styles.input, { color: theme.colors.text, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }];
  const etiqueta = [styles.etiqueta, { color: theme.colors.text, fontFamily: typography.semibold }];
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancelar}>
      <View style={styles.fondo}>
        <ScrollView style={styles.hoja} contentContainerStyle={[styles.hojaContenido, { backgroundColor: theme.colors.surface }]}
          keyboardShouldPersistTaps="handled" scrollEnabled>
          <Text style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{field.etiqueta || 'Firma'}</Text>
          <PadFirma trazos={trazos} onTrazos={(next) => { setTrazos(next); setError(''); }} svgRef={svgRef} tam={tam} />
          <TouchableOpacity onPress={() => setTrazos([])} accessibilityRole="button"
            style={[styles.accion, styles.limpiar, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
            <Ionicons name="refresh-outline" size={16} color={theme.colors.text} />
            <Text style={[styles.accionTexto, { color: theme.colors.text, fontFamily: typography.bold }]}>Limpiar</Text>
          </TouchableOpacity>
          <Text style={etiqueta}>Nombre y apellido *</Text>
          <TextInput value={nombre} onChangeText={(texto) => { setNombre(texto); setError(''); }}
            accessibilityLabel="Nombre y apellido de quien firma" placeholder="Nombre y apellido"
            placeholderTextColor={theme.colors.textSoft} autoCapitalize="words" style={input} />
          <Text style={etiqueta}>DNI *</Text>
          <TextInput value={dni} onChangeText={(texto) => { setDni(soloDigitos(texto).slice(0, 8)); setError(''); }}
            accessibilityLabel="DNI de quien firma" placeholder="Solo números"
            keyboardType="number-pad" inputMode="numeric" placeholderTextColor={theme.colors.textSoft} style={input} />
          {error ? (
            <Text accessibilityRole="alert" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{error}</Text>
          ) : null}
          <View style={styles.botones}>
            <TouchableOpacity onPress={onCancelar} accessibilityRole="button" disabled={guardando}
              style={[styles.accion, styles.flex, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
              <Text style={[styles.accionTexto, { color: theme.colors.text, fontFamily: typography.bold }]}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={confirmar} accessibilityRole="button" disabled={guardando}
              style={[styles.accion, styles.flex, { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary }]}>
              <Text style={[styles.accionTexto, { color: '#FFFFFF', fontFamily: typography.bold }]}>{guardando ? 'Guardando…' : 'Confirmar firma'}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// Campo FIRMA: se firma en un recuadro y se cargan nombre y DNI de quien firma. El valor es el
// mismo objeto de un ARCHIVO (PNG) más `firmante: { nombre, dni }`.
export default function CampoFirma({ field, value, onFirmar, onQuitar, onVer }) {
  const { theme, typography } = useTheme();
  const [abierto, setAbierto] = useState(false);
  const conImagen = Boolean(value?.uri || value?.dataUri);
  const vacio = !conImagen && !value?.firmante;
  const error = vacio ? '' : errorFirma(value, field.requerido);
  return (
    <View style={styles.formGroup}>
      <Text style={[styles.etiqueta, { color: theme.colors.text, fontFamily: typography.semibold }]}>
        {field.etiqueta}{field.requerido ? ' *' : ''}
      </Text>
      {conImagen ? (
        <View style={[styles.caja, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt }]}>
          <ResumenFirma value={value} onVer={onVer ? () => onVer(field) : undefined} />
          <View style={styles.botones}>
            <TouchableOpacity onPress={() => setAbierto(true)} accessibilityRole="button"
              style={[styles.accion, styles.flex, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
              <Ionicons name="create-outline" size={16} color={theme.colors.text} />
              <Text style={[styles.accionTexto, { color: theme.colors.text, fontFamily: typography.bold }]}>VOLVER A FIRMAR</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onQuitar?.(field)} accessibilityLabel="Quitar la firma"
              style={[styles.accion, styles.quitar, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
              <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity activeOpacity={0.86} onPress={() => setAbierto(true)} accessibilityRole="button"
          style={[styles.placeholder, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt }]}>
          <Ionicons name="create-outline" size={24} color={theme.colors.icon} />
          <Text style={[styles.placeholderTexto, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>
            Tocar para firmar
          </Text>
        </TouchableOpacity>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{error}</Text>
      ) : null}
      {abierto ? (
        <ModalFirma field={field} inicial={firmanteDe(value)} onCancelar={() => setAbierto(false)}
          onConfirmar={async (item) => { await onFirmar(item); setAbierto(false); }} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  formGroup: { marginBottom: 14 },
  etiqueta: { fontSize: fontSizes.sm, marginBottom: 7, marginTop: 4 },
  caja: { borderWidth: 1, borderRadius: radii.lg, padding: 8, gap: 8 },
  resumen: { gap: 6 },
  miniatura: { width: '100%', aspectRatio: ANCHO_FIRMA / ALTO_FIRMA, borderWidth: 1, borderRadius: radii.md, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  miniaturaImagen: { width: '100%', height: '100%' },
  firmante: { fontSize: fontSizes.xs },
  placeholder: { minHeight: 74, borderWidth: 1, borderStyle: 'dashed', borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center', padding: 12 },
  placeholderTexto: { fontSize: fontSizes.xs, marginTop: 6, textAlign: 'center' },
  botones: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  accion: { minHeight: 38, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  accionTexto: { fontSize: fontSizes.xs },
  flex: { flex: 1 },
  quitar: { width: 44, paddingHorizontal: 0 },
  limpiar: { alignSelf: 'flex-end', marginTop: 8 },
  error: { fontSize: fontSizes.xs, marginTop: 6 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.sm },
  fondo: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 16 },
  hoja: { flexGrow: 0, maxHeight: '100%' },
  hojaContenido: { borderRadius: radii.xl, padding: 16 },
  titulo: { fontSize: fontSizes.base, marginBottom: 10 },
  pad: { width: '100%', aspectRatio: ANCHO_FIRMA / ALTO_FIRMA, borderWidth: 1, borderStyle: 'dashed', borderRadius: radii.md, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  padWeb: { touchAction: 'none', userSelect: 'none', cursor: 'crosshair' },
  padGuia: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
