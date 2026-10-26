import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { haceCuanto } from '../services/avisos';
import { fontSizes, radii } from '../theme';
import CustomButton from './CustomButton';

const ICONOS = {
    relevamiento_nuevo: 'clipboard-outline',
    caso_rechazado: 'close-circle-outline',
    carga_atencion: 'alert-circle-outline',
    cargas_sin_subir: 'cloud-upload-outline',
};

// Bandeja de avisos: el más nuevo arriba y los no leídos resaltados.
export default function AvisosBandeja({ visible, avisos = [], noLeidos = 0, onClose, onPressAviso, onMarcarTodo }) {
    const { theme, typography } = useTheme();
    const ahora = Date.now();
    return (
        <Modal visible={!!visible} animationType="slide" onRequestClose={onClose}>
            <View style={[styles.pantalla, { backgroundColor: theme.colors.background }]}>
                <View style={styles.encabezado}>
                    <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Cerrar avisos" style={styles.cerrar}>
                        <Ionicons name="chevron-back" size={24} color={theme.colors.icon} />
                    </Pressable>
                    <Text style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>Notificaciones</Text>
                </View>
                {avisos.length > 0 ? (
                    <View style={styles.acciones}>
                        <CustomButton
                            title="Marcar todo como leído"
                            size="SM"
                            variant="secondary"
                            iconLeft="checkmark-done-outline"
                            onPress={onMarcarTodo}
                            disabled={noLeidos === 0}
                        />
                    </View>
                ) : null}
                <ScrollView contentContainerStyle={styles.lista} showsVerticalScrollIndicator={false}>
                    {avisos.length === 0 ? (
                        <Text style={[styles.vacio, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>No tenés avisos</Text>
                    ) : avisos.map((aviso) => {
                        const sinLeer = !aviso.leido_en;
                        return (
                            <Pressable
                                key={aviso.id}
                                onPress={() => onPressAviso?.(aviso)}
                                accessibilityRole="button"
                                accessibilityLabel={aviso.titulo}
                                style={[styles.item, {
                                    backgroundColor: sinLeer ? theme.colors.brandSoft : theme.colors.surface,
                                    borderColor: sinLeer ? theme.colors.primary : theme.colors.border,
                                }]}
                            >
                                <Ionicons name={ICONOS[aviso.tipo] || 'notifications-outline'} size={22} color={theme.colors.primary} />
                                <View style={styles.textos}>
                                    <Text style={[styles.itemTitulo, { color: theme.colors.text, fontFamily: sinLeer ? typography.bold : typography.medium }]}>{aviso.titulo}</Text>
                                    {aviso.texto ? <Text style={[styles.itemTexto, { color: theme.colors.textMuted, fontFamily: typography.regular }]}>{aviso.texto}</Text> : null}
                                    <Text style={[styles.itemFecha, { color: theme.colors.textSoft, fontFamily: typography.regular }]}>{haceCuanto(aviso.creado_en, ahora)}</Text>
                                </View>
                                {sinLeer ? <View style={[styles.punto, { backgroundColor: theme.colors.primary }]} /> : null}
                            </Pressable>
                        );
                    })}
                </ScrollView>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    pantalla: { flex: 1, paddingTop: 40 },
    encabezado: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginBottom: 8 },
    cerrar: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
    titulo: { fontSize: fontSizes.xl, marginLeft: 4 },
    acciones: { paddingHorizontal: 20, marginBottom: 8, alignItems: 'flex-start' },
    lista: { paddingHorizontal: 20, paddingBottom: 32 },
    vacio: { fontSize: fontSizes.base, textAlign: 'center', marginTop: 48 },
    item: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        padding: 14,
        borderRadius: radii.xl,
        borderWidth: 1,
        marginBottom: 10,
    },
    textos: { flex: 1, marginLeft: 12 },
    itemTitulo: { fontSize: fontSizes.sm },
    itemTexto: { fontSize: fontSizes.sm, marginTop: 2 },
    itemFecha: { fontSize: fontSizes.xs, marginTop: 6 },
    punto: { width: 10, height: 10, borderRadius: radii.full, marginLeft: 8, marginTop: 4 },
});
