import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { fontSizes, radii } from '../theme';
import FrostedBackButton from './FrostedBackButton';
import useReduceMotion from '../hooks/useReduceMotion';

export default function Banner({
    title,
    syncStatus = 'synced',
    syncPendingCount = 0,
    onSyncPress,
    showBackButton = false,
    onBackPress,
}) {
    const { theme, typography } = useTheme();
    const isSynced = syncStatus === 'synced';
    const isSyncing = syncStatus === 'syncing';

    return (
        <View style={styles.shadowContainer}>
            <LinearGradient
                colors={theme.colors.gradients?.brand || [theme.colors.primary, theme.colors.secondary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.container}
            >
                <SafeAreaView>
                    <View style={styles.headerRow}>
                        <View style={styles.leftHeaderGroup}>
                            {showBackButton ? (
                                <FrostedBackButton
                                    onPress={onBackPress}
                                    size={48}
                                    iconSize={30}
                                    iconColor="#FFFFFF"
                                    tint="dark"
                                    style={styles.backBtn}
                                />
                            ) : null}
                            <Text numberOfLines={2} style={[styles.title, String(title || '').length > 18 && styles.titleLargo, { color: '#FFF', fontFamily: typography.bold }]}>
                                {title}
                            </Text>
                        </View>

                        <Pressable
                            style={styles.iconButton}
                            onPress={onSyncPress}
                            accessibilityRole="button"
                            accessibilityLabel={isSyncing ? 'Sincronizando' : 'Sincronizar'}
                            accessibilityState={{ busy: isSyncing }}
                        >
                            <SyncIcon isSyncing={isSyncing} isSynced={isSynced} />
                            {syncPendingCount > 0 ? (
                                <View style={[styles.syncBadge, { borderColor: '#FFF', backgroundColor: theme.colors.warning }]}>
                                    <Text style={[styles.syncBadgeText, { fontFamily: typography.bold }]}>
                                        {syncPendingCount > 99 ? '99+' : syncPendingCount}
                                    </Text>
                                </View>
                            ) : null}
                        </Pressable>
                    </View>
                </SafeAreaView>
            </LinearGradient>
        </View>
    );
}

// Flechas que giran mientras sincroniza; al terminar, la nube con tilde entra con un rebote
// chico. Con «reducir movimiento» solo cambia el ícono.
function SyncIcon({ isSyncing, isSynced }) {
    const reduceMotion = useReduceMotion();
    const spin = useRef(new Animated.Value(0)).current;
    const pop = useRef(new Animated.Value(1)).current;
    const wasSyncing = useRef(isSyncing);

    useEffect(() => {
        if (!isSyncing || reduceMotion) return undefined;
        spin.setValue(0);
        const loop = Animated.loop(Animated.timing(spin, {
            toValue: 1,
            duration: 900,
            easing: Easing.linear,
            useNativeDriver: true,
        }));
        loop.start();
        return () => loop.stop();
    }, [isSyncing, reduceMotion, spin]);

    useEffect(() => {
        const termino = wasSyncing.current && !isSyncing;
        wasSyncing.current = isSyncing;
        if (!termino || reduceMotion) return;
        pop.setValue(0.6);
        Animated.spring(pop, { toValue: 1, useNativeDriver: true, damping: 10, stiffness: 260, mass: 0.7 }).start();
    }, [isSyncing, reduceMotion, pop]);

    const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

    return (
        <Animated.View style={{ transform: isSyncing ? [{ rotate }] : [{ scale: pop }] }}>
            <Ionicons
                name={isSyncing ? 'sync' : (isSynced ? 'cloud-done' : 'cloud-upload')}
                size={27}
                color="#FFF"
            />
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    shadowContainer: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.10,
        shadowRadius: 4,
        elevation: 3,
        zIndex: 10,
        borderBottomLeftRadius: radii['2xl'],
        borderBottomRightRadius: radii['2xl'],
    },
    container: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(0,0,0,0.12)',
        borderBottomLeftRadius: radii['2xl'],
        borderBottomRightRadius: radii['2xl'],
        overflow: 'hidden',
    },
    headerRow: {
        minHeight: 62,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    leftHeaderGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    backBtn: {
        marginRight: 12,
    },
    title: {
        fontSize: 21,
        lineHeight: 27,
        letterSpacing: 0,
        flexShrink: 1,
    },
    // Un título largo baja de tamaño y puede pasar a dos renglones en vez de cortarse con «…».
    titleLargo: {
        fontSize: 18,
        lineHeight: 22,
    },
    iconButton: {
        width: 48,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        marginLeft: 12,
        backgroundColor: 'rgba(255,255,255,0.16)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.34)',
    },
    syncBadge: {
        position: 'absolute',
        top: -2,
        right: -4,
        minWidth: 16,
        height: 16,
        borderRadius: radii.lg,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1.5,
        paddingHorizontal: 3,
    },
    syncBadgeText: {
        color: '#FFF',
        fontSize: fontSizes.xxs,
        lineHeight: 10,
    },
});
