import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './ThemeContext';

const ToastContext = createContext(null);

const TYPES = {
  error: { icon: 'alert-circle', label: 'Revisá los datos' },
  warning: { icon: 'warning', label: 'Atención' },
  success: { icon: 'checkmark-circle', label: 'Listo' },
  info: { icon: 'information-circle', label: 'Información' },
};

export function ToastProvider({ children }) {
  const { theme, typography } = useTheme();
  const [toast, setToast] = useState(null);
  const visibility = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);

  const hideToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    Animated.timing(visibility, { toValue: 0, duration: 180, useNativeDriver: true })
      .start(() => setToast(null));
  }, [visibility]);

  const showToast = useCallback(({ message, type = 'info', title, duration = 0, actions }) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type, title, actions: actions?.length ? actions : [{ text: 'OK' }] });
    visibility.setValue(0);
    Animated.timing(visibility, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    if (duration > 0) timerRef.current = setTimeout(hideToast, duration);
  }, [hideToast, visibility]);

  const showAlert = useCallback((title, message, buttons = [{ text: 'OK' }]) => {
    const value = `${title || ''} ${message || ''}`.toLowerCase();
    const type = /(error|no se pudo|faltan|requerido|ya relevado|no encontr)/.test(value)
      ? 'error'
      : /(sin conex|pendiente|permiso|límite|limite|atenci)/.test(value)
        ? 'warning'
        : /(complet|iniciado|finalizado|agregad|reabierto|guardado)/.test(value)
          ? 'success'
          : 'info';
    showToast({ title, message, type, actions: buttons });
  }, [showToast]);

  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), []);

  const config = TYPES[toast?.type] || TYPES.info;
  const accent = toast?.type === 'error'
    ? theme.colors.danger
    : toast?.type === 'warning'
      ? theme.colors.warning
      : toast?.type === 'success'
        ? theme.colors.success
        : theme.colors.primary;

  return (
    <ToastContext.Provider value={{ showToast, showAlert, hideToast }}>
      {children}
      {toast ? (
        <Animated.View style={[styles.host, { opacity: visibility }]}>
          <View style={[styles.toast, { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, borderLeftColor: accent }]} accessibilityRole="alert">
            <View style={styles.content}>
              <View style={[styles.icon, { backgroundColor: `${accent}18` }]}>
                <Ionicons name={config.icon} size={24} color={accent} />
              </View>
              <View style={styles.copy}>
                <Text style={[styles.title, { color: theme.colors.text, fontFamily: typography.bold }]}>
                  {toast.title || config.label}
                </Text>
                <Text style={[styles.message, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>
                  {toast.message}
                </Text>
              </View>
            </View>
            <View style={styles.actions}>
              {toast.actions.map((action, index) => {
                const isCancel = action.style === 'cancel';
                const isDestructive = action.style === 'destructive';
                const buttonColor = isDestructive ? theme.colors.danger : accent;
                return (
                  <Pressable
                    key={`${action.text || 'OK'}-${index}`}
                    onPress={() => {
                      hideToast();
                      if (action.onPress) setTimeout(action.onPress, 200);
                    }}
                    style={[
                      styles.okButton,
                      isCancel
                        ? { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border, borderWidth: 1 }
                        : { backgroundColor: buttonColor },
                    ]}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.okText, { color: isCancel ? theme.colors.text : '#FFFFFF', fontFamily: typography.bold }]}>
                      {action.text || 'OK'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 30,
    backgroundColor: 'rgba(15, 23, 42, 0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  toast: {
    width: '100%',
    maxWidth: 420,
    minHeight: 76,
    borderRadius: 18,
    borderWidth: 1,
    borderLeftWidth: 5,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: 3 },
  title: { fontSize: 14 },
  message: { fontSize: 13, lineHeight: 18 },
  actions: { marginTop: 14, flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  okButton: { minWidth: 72, borderRadius: 11, paddingVertical: 9, paddingHorizontal: 18, alignItems: 'center' },
  okText: { color: '#FFFFFF', fontSize: 13 },
});
