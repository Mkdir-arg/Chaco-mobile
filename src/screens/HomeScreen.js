import { relevamientoBadge } from '../theme/statusBadges';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, Animated, Easing } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../context/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import StaggeredItem from '../components/StaggeredItem';
import PressableScale from '../components/PressableScale';
import useReduceMotion from '../hooks/useReduceMotion';
import { designColors, fontSizes, motion, radii, shadows } from '../theme';
import { dateKey, parseAssignmentDate, formatDateTimeRange, closingSoonLabel, isDateTimeCurrentOrFuture, ASSIGNMENT_TIME_ZONE } from '../utils/dates';
import useAssignmentClock from '../hooks/useAssignmentClock';

const UI = {
    canvas: designColors.bgSecondary,
    surface: designColors.white,
    heading: designColors.textHeading,
    body: designColors.textBody,
    subtle: designColors.textBodySubtle,
    border: designColors.borderBase,
    brand: designColors.brand,
    brandSoft: designColors.bgBrandSoft,
    brandBorder: designColors.bgBrandMedium,
    brandText: designColors.textBrand,
};

// La píldora del día elegido se mueve de a un casillero: ancho del día + separación.
const DAY_WIDTH = 62;
const DAY_GAP = 8;
const DAY_STEP = DAY_WIDTH + DAY_GAP;

const DONE_STATES = ['FINALIZADO', 'TERMINADO', 'EN_REVISION', 'SINCRONIZADO', 'COMPLETADO_LOCAL', 'REALIZADO'];

export default function HomeScreen({
    onOpenRelevamientos,
    onOpenRelevamiento,
    onRefresh,
    assignedRelevamientos = [],
}) {
    const { typography } = useTheme();
    const [selectedDateKey, setSelectedDateKey] = useState(() => dateKey(new Date()));
    const [refreshing, setRefreshing] = useState(false);
    const now = useAssignmentClock(assignedRelevamientos);
    const todayDateKey = dateKey(now);

    const calendarDays = useMemo(() => {
        const today = parseAssignmentDate(todayDateKey);
        const base = Array.from({ length: 7 }, (_, index) => {
            const next = new Date(today);
            next.setUTCDate(today.getUTCDate() + index);
            return dateKey(next);
        });
        const assigned = assignedRelevamientos.flatMap((item) => assignmentDateKeys(item));
        return Array.from(new Set([...base, ...assigned])).sort();
    }, [assignedRelevamientos, todayDateKey]);

    const selectedRelevamientos = useMemo(
        () => assignedRelevamientos.filter((item) => assignmentIncludesDate(item, selectedDateKey)),
        [assignedRelevamientos, selectedDateKey]
    );
    const hasSelectedRelevamientos = selectedRelevamientos.length > 0;
    const resumen = useMemo(
        () => resumenDelDia(assignedRelevamientos, todayDateKey, now),
        [assignedRelevamientos, todayDateKey, now]
    );

    const handleRefresh = useCallback(async () => {
        if (!onRefresh || refreshing) return;
        setRefreshing(true);
        try {
            await onRefresh();
        } finally {
            setRefreshing(false);
        }
    }, [onRefresh, refreshing]);

    const selectedLabel = formatCalendarLabel(selectedDateKey);
    const sectionTitle = selectedDateKey === todayDateKey
        ? 'Hoy'
        : `${selectedLabel.day} ${Number(selectedLabel.number)} ${selectedLabel.month}`;

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
            refreshControl={(
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={handleRefresh}
                    tintColor={designColors.brand}
                    colors={[designColors.brand]}
                />
            )}
        >
            <StaggeredItem index={0}>
                <DaySummary resumen={resumen} typography={typography} />
            </StaggeredItem>

            <StaggeredItem index={1}>
                <View style={styles.calendarSection}>
                    <View style={styles.calendarHeader}>
                        <Text style={[styles.tableTitle, { fontFamily: typography.bold }]}>Calendario</Text>
                        <View style={styles.badge}>
                            <Text style={[styles.badgeText, { fontFamily: typography.bold }]}>
                                {`${assignedRelevamientos.length} asignado${assignedRelevamientos.length === 1 ? '' : 's'}`}
                            </Text>
                        </View>
                    </View>
                    <DayStrip
                        days={calendarDays}
                        selectedDateKey={selectedDateKey}
                        todayDateKey={todayDateKey}
                        relevamientos={assignedRelevamientos}
                        now={now}
                        typography={typography}
                        onSelect={setSelectedDateKey}
                    />

                    <Text style={[styles.sectionLabel, { fontFamily: typography.extrabold }]}>
                        {`${sectionTitle} · ${selectedRelevamientos.length}`}
                    </Text>

                    <View style={[styles.assignmentList, !hasSelectedRelevamientos && styles.assignmentListEmpty]}>
                        {!hasSelectedRelevamientos ? (
                            <View style={styles.emptyDay}>
                                <Ionicons name="calendar-clear-outline" size={30} color={UI.subtle} />
                                <Text style={[styles.emptyDayText, { fontFamily: typography.medium }]}>Sin relevamientos asignados para esta fecha.</Text>
                            </View>
                        ) : (
                            selectedRelevamientos.map((item) => (
                                <RelevamientoCard
                                    key={item.id}
                                    item={item}
                                    typography={typography}
                                    now={now}
                                    overdue={isOverdueRelevamiento(item, now)}
                                    onPress={() => (onOpenRelevamiento ? onOpenRelevamiento(item.id) : onOpenRelevamientos())}
                                />
                            ))
                        )}
                    </View>
                </View>
            </StaggeredItem>

        </ScrollView>
    );
}

// Resumen de hoy: cuántos están terminados y cuál cierra pronto.
function DaySummary({ resumen, typography }) {
    const { total, terminados, cierre, enCurso } = resumen;
    const radio = 19;
    const circunferencia = 2 * Math.PI * radio;
    const avance = total > 0 ? terminados / total : 0;

    let titulo = 'Hoy no tenés relevamientos';
    let detalle = 'Elegí otro día en el calendario.';
    if (total > 0) {
        titulo = `${terminados} de ${total} terminado${total === 1 ? '' : 's'} hoy`;
        if (cierre) detalle = `${cierre.titulo} · ${cierre.label}`;
        else if (terminados === total) detalle = 'Todo listo por hoy.';
        else if (enCurso > 0) detalle = `${enCurso} en curso`;
        else detalle = `${total - terminados} por empezar`;
    }

    return (
        <LinearGradient
            colors={[designColors.brand, designColors.brandStrong]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.summary}
            accessible
            accessibilityLabel={`${titulo}. ${detalle}`}
        >
            <View style={styles.summaryRing}>
                <Svg width={48} height={48} viewBox="0 0 48 48">
                    <Circle cx={24} cy={24} r={radio} stroke="rgba(255, 255, 255, 0.24)" strokeWidth={5} fill="none" />
                    {avance > 0 ? (
                        <Circle
                            cx={24}
                            cy={24}
                            r={radio}
                            stroke={designColors.white}
                            strokeWidth={5}
                            strokeLinecap="round"
                            fill="none"
                            strokeDasharray={`${circunferencia} ${circunferencia}`}
                            strokeDashoffset={circunferencia * (1 - avance)}
                            transform="rotate(-90 24 24)"
                        />
                    ) : null}
                </Svg>
                <Ionicons
                    name={total > 0 && terminados === total ? 'checkmark' : 'today-outline'}
                    size={18}
                    color={designColors.white}
                    style={styles.summaryRingIcon}
                />
            </View>
            <View style={styles.summaryCopy}>
                <Text style={[styles.summaryTitle, { fontFamily: typography.extrabold }]}>{titulo}</Text>
                <Text style={[styles.summaryDetail, { fontFamily: typography.semibold }]} numberOfLines={2}>{detalle}</Text>
            </View>
        </LinearGradient>
    );
}

// Tira de días con una píldora índigo que se desliza hasta el día elegido.
function DayStrip({ days, selectedDateKey, todayDateKey, relevamientos, now, typography, onSelect }) {
    const reduceMotion = useReduceMotion();
    const selectedIndex = Math.max(0, days.indexOf(selectedDateKey));
    const pillX = useRef(new Animated.Value(selectedIndex * DAY_STEP)).current;

    useEffect(() => {
        const toValue = selectedIndex * DAY_STEP;
        if (reduceMotion) {
            pillX.setValue(toValue);
            return;
        }
        Animated.spring(pillX, { toValue, useNativeDriver: true, ...motion.spring }).start();
    }, [selectedIndex, reduceMotion, pillX]);

    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.daysRow}>
            <Animated.View pointerEvents="none" style={[styles.dayPill, { transform: [{ translateX: pillX }] }]} />
            {days.map((key) => {
                const selected = selectedDateKey === key;
                const isToday = key === todayDateKey;
                const dayRelevamientos = relevamientos.filter((item) => assignmentIncludesDate(item, key));
                const count = dayRelevamientos.length;
                const hasOverdue = key < todayDateKey && dayRelevamientos.some((item) => isOverdueRelevamiento(item, now));
                const label = formatCalendarLabel(key);
                return (
                    <PressableScale
                        key={key}
                        haptic={!selected}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`${isToday ? 'Hoy, ' : ''}${label.day} ${Number(label.number)} ${label.month}, ${count} relevamiento${count === 1 ? '' : 's'}`}
                        onPress={() => onSelect(key)}
                        style={[styles.dayChip, !selected && (hasOverdue ? styles.dayChipOverdue : styles.dayChipIdle)]}
                    >
                        <Text style={[styles.dayName, { fontFamily: typography.bold }, isToday && styles.dayTextToday, selected && styles.dayTextSelected]}>
                            {isToday ? 'Hoy' : label.day}
                        </Text>
                        <Text style={[styles.dayNumber, { fontFamily: typography.bold }, selected && styles.dayTextSelected]}>{label.number}</Text>
                        <Text style={[styles.dayMonth, { fontFamily: typography.semibold }, selected && styles.dayTextSelected]}>{label.month}</Text>
                        {count > 0 ? (
                            <View style={[styles.dayCount, hasOverdue && styles.dayCountOverdue, selected && styles.dayCountSelected]}>
                                <Text style={[styles.dayCountText, { fontFamily: typography.extrabold }, hasOverdue && styles.dayCountTextOverdue]}>{count}</Text>
                            </View>
                        ) : null}
                    </PressableScale>
                );
            })}
        </ScrollView>
    );
}

function RelevamientoCard({ item, typography, overdue, onPress, now }) {
    const closing = !item.pausado && isOpenRelevamiento(item) ? closingSoonLabel(item.fecha_asignada, item.fecha_hasta, now) : '';
    const badge = relevamientoBadge(overdue ? 'VENCIDO' : item.estado);
    const enCurso = !overdue && !item.pausado && String(item.estado || '').toUpperCase() === 'EN_CURSO';
    const relevados = item.relevados ?? item.relevados_count ?? item.formularios_count ?? item.personas_count ?? 0;
    const zona = item.zona || item.localidad || item.direccion_objetivo || 'Sin zona';

    return (
        <PressableScale
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Abrir ${item.titulo || item.nombre || 'relevamiento'}`}
            style={[styles.assignmentRow, overdue && styles.assignmentRowOverdue]}
        >
            <View style={[styles.actionIcon, overdue && styles.actionIconOverdue]}>
                <Ionicons name={overdue ? 'alert-circle-outline' : 'clipboard-outline'} size={22} color={overdue ? designColors.warning : designColors.brand} />
            </View>
            <View style={styles.actionCopy}>
                <Text style={[styles.actionTitle, { fontFamily: typography.bold }]} numberOfLines={1}>
                    {item.titulo || item.nombre || 'Relevamiento'}
                </Text>
                <Text style={[styles.actionPeriod, { fontFamily: typography.semibold }]} numberOfLines={1}>
                    {`${formatAssignmentPeriod(item)} · ${zona}`}
                </Text>
                <View style={styles.chipsRow}>
                    <View style={[styles.chip, { backgroundColor: badge.bg }]}>
                        {enCurso ? <PulseDot color={badge.tx} /> : null}
                        <Text style={[styles.chipText, { color: badge.tx, fontFamily: typography.bold }]}>
                            {overdue ? 'Vencido' : statusLabel(item.estado)}
                        </Text>
                    </View>
                    {closing ? (
                        <View style={[styles.chip, styles.chipUrgent]}>
                            <Ionicons name="time-outline" size={11} color={designColors.warningStrong} />
                            <Text accessibilityRole="alert" style={[styles.chipText, styles.chipUrgentText, { fontFamily: typography.bold }]}>{closing}</Text>
                        </View>
                    ) : null}
                    {relevados > 0 ? (
                        <View style={[styles.chip, styles.chipSoft]}>
                            <Text style={[styles.chipText, styles.chipSoftText, { fontFamily: typography.bold }]}>{`${relevados} relevado${relevados === 1 ? '' : 's'}`}</Text>
                        </View>
                    ) : null}
                </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={UI.subtle} />
        </PressableScale>
    );
}

// Punto que late en el chip «En curso». Con «reducir movimiento» queda quieto.
function PulseDot({ color }) {
    const reduceMotion = useReduceMotion();
    const pulse = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (reduceMotion) return undefined;
        const loop = Animated.loop(Animated.timing(pulse, {
            toValue: 1,
            duration: 1600,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        }));
        loop.start();
        return () => loop.stop();
    }, [reduceMotion, pulse]);

    return (
        <View style={styles.pulseWrap}>
            {!reduceMotion ? (
                <Animated.View
                    style={[styles.pulseHalo, {
                        backgroundColor: color,
                        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
                    }]}
                />
            ) : null}
            <View style={[styles.pulseDot, { backgroundColor: color }]} />
        </View>
    );
}

function resumenDelDia(relevamientos = [], todayKey = '', now = new Date()) {
    const hoy = relevamientos.filter((item) => assignmentIncludesDate(item, todayKey));
    const terminados = hoy.filter((item) => DONE_STATES.includes(String(item.estado || '').toUpperCase())).length;
    const enCurso = hoy.filter((item) => !item.pausado && String(item.estado || '').toUpperCase() === 'EN_CURSO').length;
    let cierre = null;
    for (const item of hoy) {
        if (item.pausado || !isOpenRelevamiento(item)) continue;
        const label = closingSoonLabel(item.fecha_asignada, item.fecha_hasta, now);
        if (label) {
            cierre = { titulo: item.titulo || item.nombre || 'Relevamiento', label };
            break;
        }
    }
    return { total: hoy.length, terminados, enCurso, cierre };
}

function assignmentDateKey(item = {}) {
    return dateKey(item.fecha_asignada || item.created_at || item.relevado_at);
}

function assignmentEndDateKey(item = {}) {
    return dateKey(item.fecha_hasta || item.fecha_asignada || item.created_at || item.relevado_at);
}

function formatAssignmentPeriod(item = {}) {
    return formatDateTimeRange(item.fecha_asignada || item.created_at, item.fecha_hasta || item.fecha_asignada || item.created_at);
}

function assignmentIncludesDate(item = {}, key = '') {
    const start = assignmentDateKey(item);
    const end = assignmentEndDateKey(item);
    return !!start && !!end && key >= start && key <= end;
}

function assignmentDateKeys(item = {}) {
    const startKey = assignmentDateKey(item);
    const endKey = assignmentEndDateKey(item);
    if (!startKey || !endKey || endKey < startKey) return startKey ? [startKey] : [];
    const keys = [];
    const cursor = parseAssignmentDate(startKey);
    const end = parseAssignmentDate(endKey);
    while (cursor <= end) {
        keys.push(dateKey(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return keys;
}

function isOpenRelevamiento(item = {}) {
    const status = String(item.estado || '').toUpperCase();
    return status === 'ASIGNADO' || status === 'EN_CURSO' || status === 'FINALIZANDO';
}

function isOverdueRelevamiento(item = {}, now = new Date()) {
    return !isDateTimeCurrentOrFuture(item.fecha_hasta || item.fecha_asignada, now) && isOpenRelevamiento(item);
}

function formatCalendarLabel(key) {
    const date = parseAssignmentDate(key);
    const day = date.toLocaleDateString('es-AR', { weekday: 'short', timeZone: ASSIGNMENT_TIME_ZONE }).replace('.', '');
    const month = date.toLocaleDateString('es-AR', { month: 'short', timeZone: ASSIGNMENT_TIME_ZONE }).replace('.', '');
    return {
        day,
        number: key.split('-')[2],
        month,
    };
}

const statusLabel = (status) => relevamientoBadge(status).label;

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: UI.canvas,
    },
    content: {
        padding: 20,
        paddingBottom: 120,
        gap: 20,
    },
    summary: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 16,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        boxShadow: shadows.raised,
    },
    summaryRing: {
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    summaryRingIcon: {
        position: 'absolute',
    },
    summaryCopy: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    summaryTitle: {
        color: designColors.white,
        fontSize: fontSizes.lg,
        lineHeight: 24,
    },
    summaryDetail: {
        color: 'rgba(255, 255, 255, 0.86)',
        fontSize: fontSizes.xs,
        lineHeight: 17,
    },
    calendarSection: {
        gap: 12,
    },
    calendarHeader: {
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    daysRow: {
        gap: DAY_GAP,
        paddingRight: 4,
    },
    dayPill: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: DAY_WIDTH,
        height: 82,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        backgroundColor: UI.brand,
        boxShadow: '0 6px 14px -6px rgba(80, 89, 188, 0.7)',
    },
    dayChip: {
        width: DAY_WIDTH,
        height: 82,
        borderWidth: 1,
        borderColor: 'transparent',
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    dayChipIdle: {
        backgroundColor: UI.surface,
        borderColor: UI.border,
    },
    dayChipOverdue: {
        backgroundColor: relevamientoBadge('VENCIDO').bg,
        borderColor: relevamientoBadge('VENCIDO').bd,
    },
    dayName: {
        color: UI.subtle,
        fontSize: fontSizes.xs,
        textTransform: 'capitalize',
    },
    dayNumber: {
        color: UI.heading,
        fontSize: fontSizes.lg,
        lineHeight: 24,
    },
    dayMonth: {
        color: UI.subtle,
        fontSize: fontSizes.xxs,
        textTransform: 'capitalize',
    },
    dayTextToday: {
        color: designColors.success,
    },
    dayTextSelected: {
        color: designColors.white,
    },
    dayCount: {
        position: 'absolute',
        top: 6,
        right: 6,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        borderRadius: radii.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: UI.brandSoft,
    },
    dayCountOverdue: {
        backgroundColor: designColors.white,
    },
    dayCountSelected: {
        backgroundColor: designColors.white,
    },
    dayCountText: {
        color: UI.brandText,
        fontSize: 9,
        lineHeight: 12,
    },
    dayCountTextOverdue: {
        color: relevamientoBadge('VENCIDO').tx,
    },
    sectionLabel: {
        color: UI.subtle,
        fontSize: fontSizes.xs,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        marginTop: 4,
    },
    assignmentList: {
        gap: 10,
    },
    assignmentListEmpty: {
        minHeight: 300,
        justifyContent: 'center',
    },
    assignmentRow: {
        minHeight: 92,
        paddingHorizontal: 14,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        backgroundColor: UI.surface,
        boxShadow: shadows.card,
    },
    assignmentRowOverdue: {
        backgroundColor: relevamientoBadge('VENCIDO').bg,
    },
    emptyDay: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 28,
        gap: 10,
    },
    emptyDayText: {
        color: UI.subtle,
        fontSize: fontSizes.sm,
        lineHeight: 20,
        textAlign: 'center',
    },
    tableTitle: {
        color: UI.heading,
        fontSize: fontSizes.base,
    },
    badge: {
        minHeight: 28,
        borderRadius: radii.full,
        borderWidth: 1,
        borderColor: UI.brandBorder,
        backgroundColor: UI.brandSoft,
        paddingHorizontal: 10,
        justifyContent: 'center',
    },
    badgeText: {
        color: UI.brandText,
        fontSize: fontSizes.xs,
    },
    actionIcon: {
        width: 44,
        height: 44,
        borderRadius: radii.xl,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: UI.brandSoft,
    },
    actionIconOverdue: {
        backgroundColor: designColors.white,
    },
    actionCopy: {
        flex: 1,
        minWidth: 0,
        gap: 3,
    },
    actionTitle: {
        color: UI.heading,
        fontSize: fontSizes.base,
    },
    actionPeriod: {
        color: UI.body,
        fontSize: fontSizes.xs,
        lineHeight: 17,
    },
    chipsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        marginTop: 4,
    },
    chip: {
        minHeight: 22,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 8,
        borderRadius: radii.full,
    },
    chipText: {
        fontSize: 10,
        lineHeight: 14,
    },
    chipUrgent: {
        backgroundColor: designColors.warningSoft,
    },
    chipUrgentText: {
        color: designColors.warningStrong,
    },
    chipSoft: {
        backgroundColor: designColors.bgTertiary,
    },
    chipSoftText: {
        color: UI.body,
    },
    pulseWrap: {
        width: 6,
        height: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pulseHalo: {
        position: 'absolute',
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    pulseDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
});
