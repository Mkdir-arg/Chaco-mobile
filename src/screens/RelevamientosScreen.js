import { statusTones as BADGE, relevamientoBadge } from '../theme/statusBadges';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    Pressable,
    ActivityIndicator,
    RefreshControl,
    TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import StaggeredItem from '../components/StaggeredItem';
import PressableScale from '../components/PressableScale';
import SkeletonLoader from '../components/SkeletonLoader';
import useAssignmentClock from '../hooks/useAssignmentClock';
import relevamientoService from '../services/relevamientoService';
import { designColors, fontSizes, radii, shadows } from '../theme';
import { formatDate as formatAppDate, formatDateTimeRange, isAssignmentVisible, closingSoonLabel } from '../utils/dates';
import { keyboardDismissModeFor } from '../utils/teclado';

const DONE_STATES = ['SINCRONIZADO', 'COMPLETADO_LOCAL', 'REALIZADO', 'FINALIZADO', 'TERMINADO'];
const IN_PROGRESS_STATES = ['EN_PROGRESO', 'EN_CURSO', 'FINALIZANDO'];

const UI = {
    canvas: designColors.bgSecondary,
    surface: designColors.white,
    heading: designColors.textHeading,
    body: designColors.textBody,
    subtle: designColors.textBodySubtle,
    border: designColors.borderBase,
    borderSoft: designColors.bgTertiary,
    brand: designColors.brand,
};

const FILTER_OPTIONS = [
    { key: 'TODOS', label: 'Todos' },
    { key: 'ASIGNADOS', label: 'Asignados' },
    { key: 'EN_CURSO', label: 'En curso' },
    { key: 'FINALIZADOS', label: 'Finalizados' },
    { key: 'EN_REVISION', label: 'En revisión' },
    { key: 'SIN_SYNC', label: 'Sin sync' },
];

const normalizeEstado = (estado) => String(estado || '').toUpperCase();

// Sin tildes ni mayúsculas: «fontana» encuentra «Fontana» y «revision» encuentra «Revisión».
const normalizeSearch = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const progressLabel = (item) => relevamientoBadge(item.estado).label;
const progressBadge = (item) => relevamientoBadge(item.estado);

const syncLabel = (syncEstado) => {
    const estado = normalizeEstado(syncEstado);
    if (estado === 'SINCRONIZADO') return 'Sincronizado';
    if (estado === 'SINCRONIZANDO') return 'Sincronizando';
    if (estado === 'ERROR') return 'Error de sync';
    return 'Sin sincronizar';
};

const syncBadge = (syncEstado) => {
    const estado = normalizeEstado(syncEstado);
    if (estado === 'SINCRONIZADO') return BADGE.success;
    if (estado === 'ERROR') return BADGE.danger;
    if (estado === 'SINCRONIZANDO') return BADGE.warning;
    return BADGE.white;
};

const statusIcon = (syncEstado) => {
    const estado = normalizeEstado(syncEstado);
    if (estado === 'SINCRONIZADO') return 'cloud-done-outline';
    if (estado === 'SINCRONIZANDO') return 'sync-outline';
    if (estado === 'ERROR') return 'alert-circle-outline';
    return 'cloud-upload-outline';
};

const titleFor = (item) => {
    if (item.titulo?.trim()) return item.titulo.trim();
    if (item.observaciones?.trim()) return `Relevamiento: ${item.observaciones.trim().slice(0, 42)}`;
    return `Relevamiento Institucion #${item.id_institucion || '-'}`;
};

const valueOrDash = (value) => {
    if (value === 0) return '0';
    if (!value) return '-';
    const text = String(value).trim();
    return text || '-';
};

export default function RelevamientosScreen({ onOpenRelevamiento }) {
    const { typography } = useTheme();
    const [relevamientos, setRelevamientos] = useState([]);
    const [statusFilter, setStatusFilter] = useState('TODOS');
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const now = useAssignmentClock(relevamientos);

    const formatDate = useCallback((isoDate) => {
        return formatAppDate(isoDate);
    }, []);

    const loadRelevamientos = useCallback(async (silent = false) => {
        if (silent) setRefreshing(true);
        else setLoading(true);
        setError('');

        const result = await relevamientoService.getRelevamientos({ refreshFromRemote: true });
        if (!result.success && result.error) setError(result.error);
        setRelevamientos(result.records || []);

        setLoading(false);
        setRefreshing(false);
    }, []);

    useEffect(() => {
        loadRelevamientos();
    }, [loadRelevamientos]);

    const relevamientosDesdeHoy = useMemo(() => {
        return relevamientos
            .filter((item) => isAssignmentVisible(item, now) || normalizeEstado(item.estado) === 'EN_REVISION')
            .sort((a, b) => (
                new Date(a.fecha_asignada || a.created_at) - new Date(b.fecha_asignada || b.created_at)
            ));
    }, [relevamientos, now]);

    const filteredRelevamientos = useMemo(() => {
        if (statusFilter === 'TODOS') return relevamientosDesdeHoy;
        if (statusFilter === 'ASIGNADOS') {
            return relevamientosDesdeHoy.filter((item) => normalizeEstado(item.estado) === 'ASIGNADO');
        }
        if (statusFilter === 'EN_CURSO') {
            return relevamientosDesdeHoy.filter((item) => IN_PROGRESS_STATES.includes(normalizeEstado(item.estado)));
        }
        if (statusFilter === 'FINALIZADOS') {
            return relevamientosDesdeHoy.filter((item) => DONE_STATES.includes(normalizeEstado(item.estado)));
        }
        // EN_REVISION tiene su propio filtro: no se mezcla con En curso ni con Finalizados.
        if (statusFilter === 'EN_REVISION') {
            return relevamientosDesdeHoy.filter((item) => normalizeEstado(item.estado) === 'EN_REVISION');
        }
        if (statusFilter === 'SIN_SYNC') {
            return relevamientosDesdeHoy.filter((item) => normalizeEstado(item.sync_estado) !== 'SINCRONIZADO');
        }
        return relevamientosDesdeHoy;
    }, [relevamientosDesdeHoy, statusFilter]);

    const visibleRelevamientos = useMemo(() => {
        const search = normalizeSearch(query);
        if (!search) return filteredRelevamientos;
        return filteredRelevamientos.filter((item) => normalizeSearch([
            titleFor(item),
            item.zona,
            item.localidad,
            item.segmento,
            item.subsegmento,
            item.convocatoria_nombre,
            item.direccion_objetivo,
        ].filter(Boolean).join(' ')).includes(search));
    }, [filteredRelevamientos, query]);

    const stats = useMemo(() => {
        const total = relevamientosDesdeHoy.length;
        const inProgress = relevamientosDesdeHoy.filter((item) => IN_PROGRESS_STATES.includes(normalizeEstado(item.estado))).length;
        const done = relevamientosDesdeHoy.filter((item) => DONE_STATES.includes(normalizeEstado(item.estado))).length;
        const pendingSync = relevamientosDesdeHoy.filter((item) => normalizeEstado(item.sync_estado) !== 'SINCRONIZADO').length;
        return [
            { key: 'total', label: 'Desde hoy', value: total, tone: 'brand' },
            { key: 'progress', label: 'En curso', value: inProgress, tone: 'warning' },
            { key: 'done', label: 'Finalizados', value: done, tone: 'success' },
            { key: 'sync', label: 'Sin sync', value: pendingSync, tone: 'danger' },
        ];
    }, [relevamientosDesdeHoy]);

    const hasSearch = !!query.trim();

    return (
        <View style={styles.container}>
            <ScrollView
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={keyboardDismissModeFor('on-drag')}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => loadRelevamientos(true)}
                        colors={[UI.brand]}
                        tintColor={UI.brand}
                    />
                }
            >
                <StaggeredItem index={0}>
                    <View style={styles.statsRow} accessibilityRole="summary">
                        {stats.map((stat, index) => (
                            <StatCell key={stat.key} stat={stat} first={index === 0} typography={typography} />
                        ))}
                    </View>
                </StaggeredItem>

                <StaggeredItem index={1}>
                    <View style={styles.filterBar}>
                        <View style={styles.searchBox}>
                            <Ionicons name="search-outline" size={18} color={UI.subtle} />
                            <TextInput
                                value={query}
                                onChangeText={setQuery}
                                placeholder="Buscar por operativo o zona"
                                placeholderTextColor={UI.subtle}
                                accessibilityLabel="Buscar relevamientos por operativo o zona"
                                returnKeyType="search"
                                autoCorrect={false}
                                style={[styles.searchInput, { fontFamily: typography.medium }]}
                            />
                            {hasSearch ? (
                                <Pressable
                                    onPress={() => setQuery('')}
                                    accessibilityRole="button"
                                    accessibilityLabel="Borrar búsqueda"
                                    hitSlop={10}
                                >
                                    <Ionicons name="close-circle" size={18} color={UI.subtle} />
                                </Pressable>
                            ) : null}
                        </View>

                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filtersRow}>
                            {FILTER_OPTIONS.map((option) => {
                                const selected = statusFilter === option.key;
                                return (
                                    <PressableScale
                                        key={option.key}
                                        haptic={!selected}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected }}
                                        onPress={() => setStatusFilter(option.key)}
                                        style={[
                                            styles.filterChip,
                                            selected ? styles.filterChipSelected : styles.filterChipIdle,
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.filterChipText,
                                                { fontFamily: selected ? typography.bold : typography.semibold },
                                                selected ? styles.filterChipTextSelected : styles.filterChipTextIdle,
                                            ]}
                                        >
                                            {option.label}
                                        </Text>
                                    </PressableScale>
                                );
                            })}
                        </ScrollView>

                        <View style={styles.filterHeader}>
                            <Text style={[styles.filterHint, { fontFamily: typography.medium }]}>
                                {`${visibleRelevamientos.length} de ${relevamientosDesdeHoy.length} relevamientos desde hoy`}
                            </Text>
                            <PressableScale
                                accessibilityRole="button"
                                accessibilityLabel="Actualizar relevamientos"
                                onPress={() => loadRelevamientos(true)}
                                style={({ pressed }) => [styles.tertiaryButton, pressed && styles.pressed]}
                            >
                                {refreshing ? (
                                    <ActivityIndicator size="small" color={UI.brand} />
                                ) : (
                                    <Ionicons name="refresh-outline" size={16} color={UI.brand} />
                                )}
                                <Text style={[styles.tertiaryButtonText, { fontFamily: typography.bold }]}>Actualizar</Text>
                            </PressableScale>
                        </View>
                    </View>
                </StaggeredItem>

                {!loading && !!error ? (
                    <View style={[styles.messageCard, styles.errorCard]}>
                        <Ionicons name="alert-circle-outline" size={18} color={BADGE.danger.tx} />
                        <Text style={[styles.messageText, styles.errorText, { fontFamily: typography.semibold }]}>
                            {`Sin conexion con el servidor. Mostrando datos locales. (${error})`}
                        </Text>
                    </View>
                ) : null}

                {loading ? (
                    <View style={styles.tableCard} accessibilityLabel="Cargando relevamientos">
                        {[0, 1, 2].map((index) => (
                            <View key={index} style={[styles.skeletonRow, index === 2 && styles.rowCardLast]}>
                                <SkeletonLoader width="70%" height={14} delay={index * 120} />
                                <SkeletonLoader width="45%" height={10} delay={index * 120} />
                                <SkeletonLoader width="100%" height={46} delay={index * 120} />
                            </View>
                        ))}
                    </View>
                ) : (
                    <View style={styles.tableCard}>
                        {visibleRelevamientos.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Ionicons name={hasSearch ? 'search-outline' : 'file-tray-outline'} size={30} color={UI.subtle} />
                                <Text style={[styles.emptyTitle, { fontFamily: typography.bold }]}>
                                    {hasSearch ? 'Sin resultados' : 'Sin relevamientos'}
                                </Text>
                                <Text style={[styles.emptyText, { fontFamily: typography.regular }]}>
                                    {hasSearch
                                        ? `Ningún relevamiento coincide con «${query.trim()}».`
                                        : error
                                            ? 'No hay relevamientos locales para el filtro seleccionado.'
                                            : 'No hay relevamientos para el filtro seleccionado.'}
                                </Text>
                                {hasSearch ? (
                                    <PressableScale
                                        accessibilityRole="button"
                                        onPress={() => setQuery('')}
                                        style={styles.tertiaryButton}
                                    >
                                        <Text style={[styles.tertiaryButtonText, { fontFamily: typography.bold }]}>Borrar búsqueda</Text>
                                    </PressableScale>
                                ) : null}
                            </View>
                        ) : null}

                        {visibleRelevamientos.map((item, index) => (
                            <StaggeredItem key={item.id} index={Math.min(index, 5) + 2}>
                                <RelevamientoRow
                                    item={item}
                                    now={now}
                                    index={index}
                                    total={visibleRelevamientos.length}
                                    formatDate={formatDate}
                                    onOpenRelevamiento={onOpenRelevamiento}
                                    typography={typography}
                                />
                            </StaggeredItem>
                        ))}
                    </View>
                )}
            </ScrollView>
        </View>
    );
}

// Los cuatro números en una fila, todos visibles a la vez.
function StatCell({ stat, first, typography }) {
    const tone = toneStyles[stat.tone] || toneStyles.brand;
    const highlight = stat.key !== 'total' && stat.value > 0;
    return (
        <View style={[styles.statCell, !first && styles.statCellDivider]} accessible accessibilityLabel={`${stat.label}: ${stat.value}`}>
            <Text
                style={[styles.statValue, { fontFamily: typography.extrabold }, highlight && { color: tone.fg }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.72}
            >
                {stat.value}
            </Text>
            <Text style={[styles.statLabel, { fontFamily: typography.semibold }]} numberOfLines={1}>{stat.label}</Text>
        </View>
    );
}

function RelevamientoRow({ item, now, index, total, formatDate, onOpenRelevamiento, typography }) {
    const isDone = DONE_STATES.includes(normalizeEstado(item.estado));
    const closing = !item.pausado && !isDone && normalizeEstado(item.estado) !== 'EN_REVISION' ? closingSoonLabel(item.fecha_asignada, item.fecha_hasta, now) : '';
    const relevados = item.relevados ?? item.relevados_count ?? item.formularios_count ?? item.personas_count ?? 0;

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Abrir ${titleFor(item)}`}
            onPress={() => onOpenRelevamiento && onOpenRelevamiento(item.id)}
            style={({ pressed }) => [styles.rowCard, index === total - 1 && styles.rowCardLast, pressed && styles.rowPressed]}
        >
            <View style={styles.rowTop}>
                <View style={styles.rowTitleGroup}>
                    <Text style={[styles.rowTitle, { fontFamily: typography.bold }]} numberOfLines={2}>
                        {titleFor(item)}
                    </Text>
                    <Text style={[styles.rowSubtitle, { fontFamily: typography.medium }]}>
                        {formatDateTimeRange(item.fecha_asignada || item.created_at, item.fecha_hasta || item.fecha_asignada || item.created_at)}
                    </Text>
                    {closing ? <Text accessibilityRole="alert" style={[styles.rowSubtitle, { color: designColors.warningStrong, fontFamily: typography.semibold }]}>{closing}</Text> : null}
                    <Text style={[styles.rowSubtitle, { fontFamily: typography.medium }]} numberOfLines={1}>
                        {valueOrDash(item.convocatoria_nombre || item.descripcion || item.observaciones)}
                    </Text>
                </View>
                <Badge label={item.pausado ? 'Pausado' : progressLabel(item)} tone={item.pausado ? BADGE.warning : progressBadge(item)} typography={typography} />
            </View>

            <View style={styles.rowGrid}>
                <MetaCell
                    label="Segmento"
                    value={valueOrDash([item.segmento, item.localidad].filter(Boolean).join(' · ') || item.subsegmento)}
                    icon="layers-outline"
                    typography={typography}
                />
                <MetaCell
                    label="Zona"
                    value={valueOrDash(item.zona || item.localidad || item.direccion_objetivo)}
                    icon="location-outline"
                    typography={typography}
                />
                <MetaCell
                    label="Relevados"
                    value={valueOrDash(relevados)}
                    icon="people-outline"
                    typography={typography}
                />
            </View>

            <View style={styles.rowFooter}>
                <Badge label={syncLabel(item.sync_estado)} tone={syncBadge(item.sync_estado)} icon={statusIcon(item.sync_estado)} typography={typography} />
                <View style={styles.rowOpen}>
                    <Text style={[styles.rowOpenText, { fontFamily: typography.bold }]}>Abrir</Text>
                    <Ionicons name="chevron-forward" size={16} color={UI.brand} />
                </View>
            </View>
        </Pressable>
    );
}

function MetaCell({ label, value, icon, typography }) {
    return (
        <View style={styles.metaCell}>
            <View style={styles.metaLabelRow}>
                <Ionicons name={icon} size={13} color={UI.subtle} />
                <Text style={[styles.metaLabel, { fontFamily: typography.semibold }]}>{label}</Text>
            </View>
            <Text style={[styles.metaValue, { fontFamily: typography.semibold }]} numberOfLines={1}>
                {value}
            </Text>
        </View>
    );
}

function Badge({ label, tone, icon, typography }) {
    return (
        <View style={[styles.badge, { backgroundColor: tone.bg, borderColor: tone.bd }]}>
            {icon ? <Ionicons name={icon} size={13} color={tone.tx} /> : null}
            <Text style={[styles.badgeText, { color: tone.tx, fontFamily: typography.bold }]} numberOfLines={1}>
                {label}
            </Text>
        </View>
    );
}

const toneStyles = {
    brand: { bg: designColors.bgBrandSoft, fg: UI.brand },
    warning: { bg: designColors.warningSoft, fg: designColors.warningStrong },
    success: { bg: designColors.successSoft, fg: designColors.success },
    danger: { bg: designColors.dangerSoft, fg: designColors.danger },
};

const cardShadow = {
    boxShadow: shadows.card,
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: UI.canvas,
    },
    content: {
        padding: 20,
        paddingBottom: 28,
    },
    pressed: {
        opacity: 0.82,
    },
    statsRow: {
        ...cardShadow,
        flexDirection: 'row',
        backgroundColor: UI.surface,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        marginBottom: 14,
    },
    statCell: {
        flex: 1,
        minWidth: 0,
        paddingVertical: 12,
        paddingHorizontal: 10,
        gap: 2,
    },
    statCellDivider: {
        borderLeftWidth: 1,
        borderLeftColor: UI.borderSoft,
    },
    statLabel: {
        color: UI.subtle,
        fontSize: 11,
    },
    statValue: {
        color: UI.heading,
        fontSize: 22,
        lineHeight: 28,
        fontVariant: ['tabular-nums'],
    },
    searchBox: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        borderRadius: radii.xl,
        borderCurve: 'continuous',
        backgroundColor: UI.borderSoft,
    },
    searchInput: {
        flex: 1,
        minWidth: 0,
        paddingVertical: 10,
        color: UI.heading,
        fontSize: fontSizes.sm,
    },
    filterBar: {
        ...cardShadow,
        backgroundColor: UI.surface,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        padding: 14,
        marginBottom: 16,
        gap: 12,
    },
    filterHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
    },
    filterHint: {
        color: UI.subtle,
        fontSize: fontSizes.xs,
        marginTop: 2,
    },
    tertiaryButton: {
        minHeight: 40,
        borderRadius: radii.full,
        borderWidth: 1,
        borderColor: UI.brand,
        backgroundColor: UI.surface,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    tertiaryButtonText: {
        color: UI.brand,
        fontSize: fontSizes.xs,
    },
    filtersRow: {
        gap: 8,
        paddingRight: 4,
    },
    filterChip: {
        borderWidth: 1,
        borderRadius: radii.full,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    filterChipIdle: {
        backgroundColor: UI.surface,
        borderColor: UI.border,
    },
    filterChipSelected: {
        backgroundColor: designColors.bgBrandSoft,
        borderColor: designColors.bgBrandMedium,
    },
    filterChipText: {
        fontSize: fontSizes.xs,
    },
    filterChipTextIdle: {
        color: UI.body,
    },
    filterChipTextSelected: {
        color: designColors.textBrand,
    },
    messageCard: {
        borderRadius: radii.xl,
        borderWidth: 1,
        padding: 14,
        marginBottom: 14,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    errorCard: {
        backgroundColor: BADGE.danger.bg,
        borderColor: BADGE.danger.bd,
    },
    messageText: {
        flex: 1,
        fontSize: fontSizes.xs,
        lineHeight: 18,
    },
    errorText: {
        color: BADGE.danger.tx,
    },
    tableCard: {
        ...cardShadow,
        backgroundColor: UI.surface,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        overflow: 'hidden',
    },
    emptyState: {
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 34,
        gap: 8,
    },
    emptyTitle: {
        color: UI.heading,
        fontSize: fontSizes.base,
    },
    emptyText: {
        color: UI.subtle,
        fontSize: fontSizes.sm,
        lineHeight: 20,
        textAlign: 'center',
    },
    rowCard: {
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: UI.borderSoft,
        backgroundColor: UI.surface,
    },
    skeletonRow: {
        padding: 16,
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: UI.borderSoft,
    },
    rowOpen: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    rowOpenText: {
        color: UI.brand,
        fontSize: fontSizes.xs,
    },
    rowCardLast: {
        borderBottomWidth: 0,
    },
    rowPressed: {
        backgroundColor: designColors.bgBrandSofter,
    },
    rowTop: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 12,
    },
    rowTitleGroup: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    rowTitle: {
        color: UI.heading,
        fontSize: fontSizes.base,
        lineHeight: 21,
    },
    rowSubtitle: {
        color: UI.subtle,
        fontSize: fontSizes.xs,
    },
    rowGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        marginBottom: 12,
    },
    metaCell: {
        width: '47%',
        minHeight: 58,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: UI.borderSoft,
        backgroundColor: UI.canvas,
        padding: 10,
        gap: 5,
    },
    metaLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    metaLabel: {
        color: UI.subtle,
        fontSize: fontSizes.xs,
    },
    metaValue: {
        color: UI.heading,
        fontSize: fontSizes.xs,
    },
    rowFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    badge: {
        maxWidth: 150,
        minHeight: 28,
        borderWidth: 1,
        borderRadius: radii.full,
        paddingHorizontal: 9,
        paddingVertical: 5,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
    },
    badgeText: {
        fontSize: fontSizes.xs,
    },
});
