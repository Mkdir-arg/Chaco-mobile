import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CameraView } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { designColors, fontSizes, radii } from '../theme';

export default function CameraModal({
  visible,
  purpose = 'photo',
  locked = false,
  onClose,
  onPhoto,
  onBarcodeScanned,
  onError,
}) {
  const { theme, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef(null);
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [session, setSession] = useState(0);

  useEffect(() => {
    if (!visible) {
      setMounted(false);
      setReady(false);
      setCapturing(false);
      return undefined;
    }
    setSession((value) => value + 1);
    setMounted(true);
    return undefined;
  }, [visible, purpose]);

  const close = () => {
    if (!capturing) onClose?.();
  };

  const capture = async () => {
    if (!cameraRef.current || !ready || capturing) return;
    setCapturing(true);
    try {
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('La camara no respondio. Cerra y volve a intentar.')), 10000);
      });
      const asset = await Promise.race([
        cameraRef.current.takePictureAsync({ quality: 0.78 }),
        timeout,
      ]);
      await onPhoto?.(asset);
    } catch (error) {
      onError?.(error);
    } finally {
      setCapturing(false);
    }
  };

  const scanner = purpose === 'scanner';

  return (
    <Modal
      visible={visible}
      animationType="none"
      presentationStyle="fullScreen"
      statusBarTranslucent
      hardwareAccelerated
      onRequestClose={close}
    >
      <View style={[styles.screen, { paddingTop: Math.max(insets.top, 18), paddingBottom: Math.max(insets.bottom, 18) }]}>
        <View style={[styles.panel, { backgroundColor: theme.colors.surface }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.text, fontFamily: typography.bold }]}>
              {scanner ? 'Escanear DNI' : 'Tomar foto'}
            </Text>
            <TouchableOpacity onPress={close} disabled={capturing} style={[styles.close, { backgroundColor: theme.colors.surfaceAlt }]}>
              <Ionicons name="close" size={22} color={theme.colors.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.cameraFrame}>
            {mounted ? (
              <CameraView
                key={`${purpose}-${session}`}
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                facing="back"
                mode="picture"
                active={visible && mounted}
                barcodeScannerSettings={scanner ? { barcodeTypes: ['qr', 'pdf417'] } : undefined}
                onBarcodeScanned={scanner && !locked ? onBarcodeScanned : undefined}
                onCameraReady={() => setReady(true)}
                onMountError={(event) => {
                  setReady(false);
                  onError?.(new Error(event?.message || 'No se pudo iniciar la camara.'));
                }}
              />
            ) : null}
            {!ready ? (
              <View style={styles.starting}>
                <ActivityIndicator color={designColors.white} />
                <Text style={[styles.startingText, { fontFamily: typography.medium }]}>Iniciando camara...</Text>
              </View>
            ) : null}
            {scanner ? <View pointerEvents="none" style={styles.frameBorder} /> : null}
          </View>

          {scanner ? (
            <Text style={[styles.help, { color: theme.colors.textMuted, fontFamily: typography.medium }]}>Alinea el codigo del DNI dentro del recuadro.</Text>
          ) : (
            <TouchableOpacity
              onPress={capture}
              disabled={!ready || capturing}
              style={[styles.capture, { backgroundColor: theme.colors.primary }, (!ready || capturing) && styles.disabled]}
            >
              {capturing ? <ActivityIndicator color={designColors.white} /> : <Ionicons name="camera" size={28} color={designColors.white} />}
              <Text style={[styles.captureText, { fontFamily: typography.bold }]}>TOMAR FOTO</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', paddingHorizontal: 18, backgroundColor: '#101114' },
  panel: { width: '100%', maxWidth: 760, alignSelf: 'center', borderRadius: radii.xl, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: fontSizes.lg },
  close: { width: 42, height: 42, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  cameraFrame: { width: '100%', aspectRatio: 1.58, borderRadius: radii.lg, overflow: 'hidden', backgroundColor: '#000000' },
  starting: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  startingText: { marginTop: 10, color: designColors.white, fontSize: fontSizes.sm },
  frameBorder: { ...StyleSheet.absoluteFillObject, borderWidth: 2, borderColor: designColors.white, borderRadius: radii.lg },
  help: { marginTop: 12, textAlign: 'center', fontSize: fontSizes.sm },
  capture: { minHeight: 54, marginTop: 14, borderRadius: radii.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  captureText: { marginLeft: 10, color: designColors.white, fontSize: fontSizes.sm },
  disabled: { opacity: 0.5 },
});
