import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TouchableOpacity, Image, Modal, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../components/FormInput';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import CustomButton from '../components/CustomButton';
import FechaInput from '../components/FechaInput';
import CampoFormulario from '../components/formulario/CampoFormulario';
import GrupoFormulario from '../components/formulario/GrupoFormulario';
import * as ImagePicker from '../services/imagePicker';
import * as DocumentPicker from '../services/documentPicker';
import { evaluarDiseno, problemasDelDiseno } from '../services/definicionFormulario';
import { getInspeccion, enviarResultado } from '../services/dispositivosService';
import {
  leerBorrador, guardarBorrador, borrarBorrador, copiarParaBorrador, borrarArchivoDelBorrador,
} from '../services/dispositivosBorrador';
import { prepararAsset, CRITICIDADES, direccionDe } from '../utils/dispositivos';
import { statusTones } from '../theme/statusBadges';
import { keyboardDismissModeFor } from '../utils/teclado';
import { fontSizes, radii } from '../theme';

const AUTOGUARDADO_MS = 500;
const vacio = (valor) => valor == null || valor === '' || (Array.isArray(valor) && !valor.length);

export default function DispositivoCompletarScreen({ inspeccionId, onTerminar }) {
  const { theme, typography } = useTheme();
  const { showToast, showAlert } = useToast();
  const { user } = useAuth();
  const ownerId = String(user?.id ?? '');
  const [detalle, setDetalle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [valores, setValores] = useState({});
  const [criticidad, setCriticidad] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [fotos, setFotos] = useState([]);
  const [busqueda, setBusqueda] = useState({});
  const [faltantes, setFaltantes] = useState([]);
  const [enviando, setEnviando] = useState(false);
  const [vista, setVista] = useState(null);
  const capturadoEn = useRef(new Date()).current;
  const cargado = useRef(false);
  const enviado = useRef(false);
  const ultimo = useRef(null);

  useEffect(() => {
    let activo = true;
    (async () => {
      try {
        const result = await getInspeccion(inspeccionId, { refreshFromRemote: false });
        if (!activo) return;
        if (!result) { setError('No se pudo cargar el relevamiento.'); return; }
        setDetalle(result);
        const borrador = await leerBorrador(ownerId, inspeccionId);
        if (!activo) return;
        if (borrador) {
          setValores(borrador.valores || {});
          setCriticidad(borrador.criticidad || '');
          setObservaciones(borrador.observaciones || '');
          setFotos(borrador.fotos || []);
          showToast({ type: 'info', message: borrador.sinArchivos
            ? 'Recuperamos lo que habías cargado. Las fotos y archivos hay que volver a adjuntarlos.'
            : 'Recuperamos lo que habías cargado.' });
        }
      } catch (e) {
        if (activo) setError(e?.message || 'No se pudo cargar el relevamiento.');
      } finally {
        cargado.current = true;
        if (activo) setLoading(false);
      }
    })();
    return () => { activo = false; };
  }, [inspeccionId]);

  // En web la URL blob: no sobrevive a recargar: esos archivos no van al borrador.
  const instantanea = () => {
    const web = Platform.OS === 'web';
    const archivosValores = Object.entries(valores).filter(([, valor]) => valor?.uri);
    const sinArchivos = web && (fotos.length > 0 || archivosValores.length > 0);
    return {
      criticidad,
      observaciones,
      valores: web ? Object.fromEntries(Object.entries(valores).filter(([, valor]) => !valor?.uri)) : valores,
      fotos: web ? [] : fotos,
      sinArchivos,
    };
  };

  useEffect(() => {
    if (!cargado.current || enviado.current) return undefined;
    const datos = instantanea();
    ultimo.current = datos;
    const algo = datos.criticidad || datos.observaciones || datos.fotos.length || datos.sinArchivos
      || Object.keys(datos.valores).length;
    if (!algo) return undefined;
    const timer = setTimeout(() => guardarBorrador(ownerId, inspeccionId, datos), AUTOGUARDADO_MS);
    return () => clearTimeout(timer);
  }, [valores, criticidad, observaciones, fotos]);

  // Lo último tipeado no espera al temporizador si se cierra la pantalla.
  useEffect(() => () => {
    if (cargado.current && !enviado.current && ultimo.current) guardarBorrador(ownerId, inspeccionId, ultimo.current);
  }, []);

  const formulario = detalle?.formulario || null;
  const diseno = useMemo(
    () => (formulario ? evaluarDiseno(formulario.definicion, { valores }, capturadoEn) : null),
    [formulario, valores]);

  const ponerValor = (clave, valor) => setValores((prev) => ({ ...prev, [clave]: valor }));

  const avisar = (e, base) => showToast({ type: 'error', message: e?.message || base });

  const prepararItem = async (asset, tipo) => copiarParaBorrador(prepararAsset(asset, { tipo }));

  // ---- Fotos ----
  const sumarFotos = async (assets = []) => {
    const nuevas = [];
    let falla = null;
    for (const asset of assets) {
      try {
        const item = await prepararItem(asset, 'foto');
        nuevas.push({ ...item, id: `${Date.now()}_${nuevas.length}_${Math.random().toString(36).slice(2, 6)}`, descripcion: '' });
      } catch (e) {
        falla = falla || e;
      }
    }
    if (nuevas.length) setFotos((prev) => [...prev, ...nuevas]);
    if (falla) avisar(falla, 'No se pudo agregar la foto.');
  };

  const camara = async () => {
    if (Platform.OS !== 'web') {
      const permiso = await ImagePicker.requestCameraPermissionsAsync();
      if (!permiso?.granted) { showToast({ type: 'warning', message: 'Necesitamos permiso de la cámara para sacar la foto.' }); return null; }
    }
    return ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8 });
  };
  const galeria = (multiple) => ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], allowsEditing: false, allowsMultipleSelection: multiple, quality: 0.8,
  });

  const agregarFotoCamara = async () => {
    try {
      const result = await camara();
      if (result && !result.canceled) await sumarFotos(result.assets);
    } catch (e) { avisar(e, 'No se pudo abrir la cámara.'); }
  };
  const agregarFotoGaleria = async () => {
    try {
      const result = await galeria(true);
      if (!result.canceled) await sumarFotos(result.assets);
    } catch (e) { avisar(e, 'No se pudo abrir la galería.'); }
  };
  const quitarFoto = (foto) => {
    borrarArchivoDelBorrador(foto);
    setFotos((prev) => prev.filter((item) => item.id !== foto.id));
  };

  // ---- Archivo de un campo ARCHIVO ----
  const guardarArchivo = async (field, asset) => {
    try {
      const item = await prepararItem(asset, 'adjunto');
      const anterior = valores[field.clave];
      if (anterior?.uri) borrarArchivoDelBorrador(anterior);
      ponerValor(field.clave, item);
    } catch (e) { avisar(e, 'No se pudo adjuntar el archivo.'); }
  };
  const abrirArchivo = (field) => {
    const elegir = (obtener) => async () => {
      try {
        const result = await obtener();
        if (result && !result.canceled && result.assets?.[0]) await guardarArchivo(field, result.assets[0]);
      } catch (e) { avisar(e, 'No se pudo adjuntar el archivo.'); }
    };
    showAlert(field?.etiqueta || 'Archivo', 'Adjuntar archivo', [
      { text: 'Cámara', onPress: elegir(camara) },
      { text: 'Galería', onPress: elegir(() => galeria(false)) },
      { text: 'Archivo', onPress: elegir(() => DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'], copyToCacheDirectory: true, multiple: false })) },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  };
  const quitarArchivo = (field) => {
    borrarArchivoDelBorrador(valores[field.clave]);
    setValores((prev) => { const next = { ...prev }; delete next[field.clave]; return next; });
  };
  const verArchivo = (field) => {
    const archivo = valores[field.clave];
    if (archivo?.uri) setVista({ uri: archivo.uri, nombre: archivo.fileName });
    else abrirArchivo(field);
  };

  // ---- Envío ----
  const calcularFaltantes = () => [
    ...(criticidad ? [] : ['Criticidad: elegí Baja, Media o Alta.']),
    ...(diseno ? problemasDelDiseno(diseno.campos, diseno.efectivas) : []),
  ];

  const armarResultado = () => {
    const respuestas = {};
    const archivos = {};
    for (const campo of diseno?.campos || []) {
      const valor = diseno.efectivas[campo.clave];
      if (campo.tipo === 'ARCHIVO') {
        if (valor?.uri) archivos[campo.clave] = valor;
      } else if (!vacio(valor)) {
        respuestas[campo.clave] = campo.tipo === 'INT' && /^-?\d+$/.test(String(valor).trim()) ? Number(valor) : valor;
      }
    }
    return {
      criticidad,
      observaciones,
      fotos: fotos.map(({ uri, fileName, mimeType, size, descripcion }) => ({ uri, fileName, mimeType, size, descripcion })),
      ...(formulario ? { respuestas, archivos, versionCapturada: formulario.version } : {}),
    };
  };

  const enviar = async () => {
    const faltan = calcularFaltantes();
    setFaltantes(faltan);
    if (faltan.length) {
      showToast({ type: 'warning', message: `Faltan ${faltan.length} dato${faltan.length === 1 ? '' : 's'} para poder enviar.` });
      return;
    }
    setEnviando(true);
    try {
      const resultado = await enviarResultado(inspeccionId, armarResultado());
      enviado.current = true;
      await borrarBorrador(ownerId, inspeccionId, ultimo.current || instantanea());
      const estado = resultado?.envio?.estado;
      if (estado === 'enviado') showToast({ type: 'success', message: 'Relevamiento enviado.' });
      else if (estado === 'error') showToast({ type: 'warning', message: 'El envío tuvo un problema; mirá el detalle del relevamiento.' });
      else showToast({ type: 'info', message: 'Guardado en el teléfono. Se envía solo apenas haya conexión.' });
      if (onTerminar) onTerminar(resultado);
    } catch (e) {
      showAlert('No se pudo enviar', e?.message || 'Probá de nuevo.');
    } finally {
      setEnviando(false);
    }
  };

  if (loading) return <View style={styles.centro}><ActivityIndicator size="large" color={theme.colors.primary} /></View>;
  if (!detalle) {
    return (
      <View style={styles.centro}>
        <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{error}</Text>
      </View>
    );
  }

  const tarjeta = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
  const titulo = [styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }];
  const edificio = detalle.edificio || {};

  const renderCampo = (field) => (
    <CampoFormulario key={field.id} field={field} value={valores[field.clave] ?? ''}
      onChange={(valor) => ponerValor(field.clave, valor)}
      busqueda={busqueda[field.clave] || ''}
      onBuscar={(texto) => setBusqueda((prev) => ({ ...prev, [field.clave]: texto }))}
      renderFecha={(props) => <FechaInput {...props} />}
      onAbrirArchivo={abrirArchivo} onQuitarArchivo={quitarArchivo} onVerArchivo={verArchivo} />
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardDismissModeFor(Platform.OS === 'ios' ? 'interactive' : 'on-drag')}>
      <View style={tarjeta}>
        <Text style={titulo}>{edificio.nombre || `Relevamiento ${detalle.id}`}</Text>
        <Text style={[styles.texto, { color: theme.colors.textMuted, fontFamily: typography.medium }]}>{direccionDe(edificio)}</Text>
      </View>

      {diseno ? diseno.grupos.map((grupo) => (
        <GrupoFormulario key={grupo.clave} group={grupo} renderCampo={renderCampo}
          onEnlaceFallido={() => showToast({ type: 'error', message: 'No se pudo abrir el enlace.' })} />
      )) : null}

      <View style={tarjeta}>
        <Text style={titulo}>Criticidad *</Text>
        <View style={styles.segmentado}>
          {CRITICIDADES.map(({ valor, titulo: nombre }) => {
            const elegido = criticidad === valor;
            return (
              <Pressable key={valor} accessibilityRole="button" accessibilityState={{ selected: elegido }}
                onPress={() => setCriticidad(valor)}
                style={[styles.segmento, { borderColor: elegido ? theme.colors.primary : theme.colors.border,
                  backgroundColor: elegido ? `${theme.colors.primary}18` : theme.colors.surface }]}>
                <Text style={{ color: elegido ? theme.colors.primary : theme.colors.text, fontFamily: elegido ? typography.bold : typography.medium }}>{nombre}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={[titulo, { marginTop: 12 }]}>Observaciones</Text>
        <TextInput value={observaciones} onChangeText={setObservaciones} multiline
          accessibilityLabel="Observaciones" placeholder="Algo más que quieras dejar asentado"
          placeholderTextColor={theme.colors.textSoft}
          style={[styles.input, styles.areaTexto, { color: theme.colors.text, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]} />
      </View>

      <View style={tarjeta}>
        <Text style={titulo}>Fotos</Text>
        <View style={styles.fila}>
          <View style={styles.flex}><CustomButton title="Sacar foto" variant="secondary" iconLeft="camera-outline" onPress={agregarFotoCamara} /></View>
          <View style={styles.flex}><CustomButton title="Galería" variant="secondary" iconLeft="images-outline" onPress={agregarFotoGaleria} /></View>
        </View>
        {fotos.map((foto) => (
          <View key={foto.id} style={[styles.foto, { borderColor: theme.colors.border }]}>
            <TouchableOpacity onPress={() => setVista({ uri: foto.uri, nombre: foto.fileName })}>
              <Image source={{ uri: foto.uri }} style={styles.miniatura} />
            </TouchableOpacity>
            <TextInput value={foto.descripcion} placeholder="Descripción (opcional)" placeholderTextColor={theme.colors.textSoft}
              accessibilityLabel="Descripción de la foto"
              onChangeText={(texto) => setFotos((prev) => prev.map((item) => (item.id === foto.id ? { ...item, descripcion: texto } : item)))}
              style={[styles.input, styles.flex, { color: theme.colors.text, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]} />
            <TouchableOpacity accessibilityLabel="Quitar foto" onPress={() => quitarFoto(foto)}>
              <Ionicons name="trash-outline" size={20} color={theme.colors.danger} />
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {faltantes.length ? (
        <View accessibilityRole="alert" style={[styles.card, { backgroundColor: statusTones.danger.bg, borderColor: statusTones.danger.bd }]}>
          <Text style={[styles.titulo, { color: statusTones.danger.tx, fontFamily: typography.bold }]}>Falta completar</Text>
          {faltantes.map((texto) => (
            <Text key={texto} style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.medium }]}>{`• ${texto}`}</Text>
          ))}
        </View>
      ) : null}

      <CustomButton title="Confirmar y enviar" size="L" iconLeft="send-outline" loading={enviando} disabled={enviando} onPress={enviar} />

      <Modal visible={!!vista} transparent animationType="fade" onRequestClose={() => setVista(null)}>
        <Pressable style={styles.vista} onPress={() => setVista(null)} accessibilityLabel="Cerrar vista previa">
          {vista ? <Image source={{ uri: vista.uri }} style={styles.vistaImagen} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 6 },
  titulo: { fontSize: fontSizes.base },
  texto: { fontSize: fontSizes.sm },
  segmentado: { flexDirection: 'row', gap: 8 },
  segmento: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.sm },
  areaTexto: { minHeight: 96, textAlignVertical: 'top' },
  fila: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  foto: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 8 },
  miniatura: { width: 64, height: 64, borderRadius: radii.md },
  vista: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' },
  vistaImagen: { width: '100%', height: '100%' },
});
