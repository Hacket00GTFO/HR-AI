'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchJson, sendJson, ApiError } from '@/lib/http';
import {
    monitoringOverviewSchema,
    containerListSchema,
    containerSeriesSchema,
    sparklinesSchema,
    servicesRedSchema,
    targetsSchema,
    grafanaLinksSchema,
    alertListSchema,
    alertCountSchema,
    type MonitoringOverview,
    type ContainerInfo,
    type ContainerSeries,
    type Sparklines,
    type ServiceRed,
    type TargetInfo,
    type GrafanaLinks,
    type AlertInfo,
    type AlertCount
} from '@/lib/schemas';
import { useTranslations } from 'next-intl';
import {
    LineChart,
    Line,
    AreaChart,
    Area,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend
} from 'recharts';

type Tab = 'overview' | 'containers' | 'services' | 'alerts' | 'grafana';
type Range = '15m' | '1h' | '6h' | '24h' | '7d';

const RANGES: Range[] = ['15m', '1h', '6h', '24h', '7d'];
const REFRESH_MS = 15000;

// ---- formatting helpers ----
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatPercent(v: number): string {
    return `${v.toFixed(1)}%`;
}

function formatDuration(seconds: number): string {
    if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
    if (seconds < 60) return `${seconds.toFixed(2)}s`;
    return `${(seconds / 60).toFixed(1)}m`;
}

function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(iso: string): string {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

// ---- severity colors ----
const SEVERITY_COLORS: Record<string, string> = {
    critical: '#ef4444',
    warning: '#f59e0b',
    info: '#3b82f6'
};

const STATUS_COLORS: Record<string, string> = {
    firing: '#ef4444',
    resolved: '#22c55e',
    pending: '#f59e0b'
};

// ---- KPI Card ----
function KpiCard({ label, value, color }: { label: string; value: string | number; color?: string | undefined }) {
    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-bold" style={color ? { color } : undefined}>
                {value}
            </div>
        </div>
    );
}

// ---- Chart wrapper ----
function ChartContainer({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="mb-3 text-sm font-medium">{title}</h3>
            <div style={{ width: '100%', height: 200 }}>{children}</div>
        </div>
    );
}

// ---- Main component ----
export function MonitoringClient() {
    const t = useTranslations('admin.monitoring');
    const [tab, setTab] = useState<Tab>('overview');
    const [range, setRange] = useState<Range>('1h');
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

    // Data states
    const [overview, setOverview] = useState<MonitoringOverview | null>(null);
    const [containers, setContainers] = useState<ContainerInfo[]>([]);
    const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
    const [containerSeries, setContainerSeries] = useState<ContainerSeries | null>(null);
    const [services, setServices] = useState<ServiceRed[]>([]);
    const [targets, setTargets] = useState<TargetInfo[]>([]);
    const [alerts, setAlerts] = useState<AlertInfo[]>([]);
    const [alertCount, setAlertCount] = useState<AlertCount>({ firing: 0, critical: 0, warning: 0 });
    const [grafanaLinks, setGrafanaLinks] = useState<GrafanaLinks | null>(null);

    // Error/loading states
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [prometheusDown, setPrometheusDown] = useState(false);

    // ---- Fetch functions ----
    const fetchOverview = useCallback(async () => {
        try {
            const data = await fetchJson('/api/proxy/admin/monitoring/overview', monitoringOverviewSchema);
            setOverview(data);
            setPrometheusDown(false);
        } catch (err) {
            if (err instanceof ApiError && err.status === 503) {
                setPrometheusDown(true);
            } else {
                setError(err instanceof Error ? err.message : 'Unknown error');
            }
        }
    }, []);

    const fetchContainers = useCallback(async () => {
        try {
            const data = await fetchJson('/api/proxy/admin/monitoring/containers', containerListSchema);
            setContainers(data.containers);
            setPrometheusDown(false);
        } catch (err) {
            if (err instanceof ApiError && err.status === 503) setPrometheusDown(true);
        }
    }, []);

    const fetchContainerSeries = useCallback(async (container: string, r: Range) => {
        try {
            const data = await fetchJson(
                `/api/proxy/admin/monitoring/containers/${encodeURIComponent(container)}/series?range=${r}`,
                containerSeriesSchema
            );
            setContainerSeries(data);
        } catch (err) {
            if (err instanceof ApiError && err.status === 503) setPrometheusDown(true);
        }
    }, []);

    const fetchServices = useCallback(async () => {
        try {
            const data = await fetchJson('/api/proxy/admin/monitoring/services/red', servicesRedSchema);
            setServices(data.services);
            setPrometheusDown(false);
        } catch (err) {
            if (err instanceof ApiError && err.status === 503) setPrometheusDown(true);
        }
    }, []);

    const fetchTargets = useCallback(async () => {
        try {
            const data = await fetchJson('/api/proxy/admin/monitoring/targets', targetsSchema);
            setTargets(data.targets);
        } catch (err) {
            // targets are non-critical
        }
    }, []);

    const fetchAlerts = useCallback(async () => {
        try {
            const [listRes, countRes] = await Promise.all([
                fetchJson('/api/proxy/admin/alerts?limit=50', alertListSchema),
                fetchJson('/api/proxy/admin/alerts/count', alertCountSchema)
            ]);
            setAlerts(listRes.alerts);
            setAlertCount(countRes);
        } catch (err) {
            // alerts may not be available yet
        }
    }, []);

    const fetchGrafanaLinks = useCallback(async () => {
        try {
            const data = await fetchJson('/api/proxy/admin/monitoring/links', grafanaLinksSchema);
            setGrafanaLinks(data);
        } catch {
            // non-critical
        }
    }, []);

    // ---- Initial load ----
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            await Promise.all([fetchOverview(), fetchContainers(), fetchGrafanaLinks()]);
            if (!cancelled) {
                setLoading(false);
                setLastUpdated(new Date());
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ---- Auto-refresh ----
    useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(async () => {
            if (tab === 'overview') await fetchOverview();
            if (tab === 'containers') await fetchContainers();
            if (tab === 'services') await fetchServices();
            if (tab === 'alerts') await fetchAlerts();
            setLastUpdated(new Date());
        }, REFRESH_MS);
        return () => clearInterval(interval);
    }, [autoRefresh, tab, fetchOverview, fetchContainers, fetchServices, fetchAlerts]);

    // ---- Tab change fetch ----
    useEffect(() => {
        if (tab === 'services' && services.length === 0) fetchServices();
        if (tab === 'alerts') fetchAlerts();
        if (tab === 'grafana' && !grafanaLinks) fetchGrafanaLinks();
    }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

    // ---- Container selection ----
    useEffect(() => {
        if (selectedContainer) {
            fetchContainerSeries(selectedContainer, range);
        }
    }, [selectedContainer, range, fetchContainerSeries]);

    // ---- Acknowledge alert ----
    const handleAck = useCallback(
        async (id: number) => {
            try {
                const { res } = await sendJson(`/api/proxy/admin/alerts/${id}/ack`, { method: 'POST' });
                if (!res.ok) return;
                fetchAlerts();
            } catch {
                // ignore
            }
        },
        [fetchAlerts]
    );

    // ---- Manual refresh ----
    const handleRefresh = useCallback(async () => {
        await Promise.all([fetchOverview(), fetchContainers()]);
        if (tab === 'services') await fetchServices();
        if (tab === 'alerts') await fetchAlerts();
        setLastUpdated(new Date());
    }, [tab, fetchOverview, fetchContainers, fetchServices, fetchAlerts]);

    // ---- Chart data transforms ----
    const overviewChartData = useMemo(() => {
        if (!containerSeries) return [];
        const series = containerSeries.series;
        const len = Math.max(series.cpu.length, series.memory.length);
        const data: Array<{ ts: string; cpu: number; memory: number }> = [];
        for (let i = 0; i < len; i++) {
            data.push({
                ts: series.cpu[i] ? formatTimestamp(series.cpu[i]!.ts) : formatTimestamp(series.memory[i]?.ts || 0),
                cpu: series.cpu[i]?.value ?? 0,
                memory: series.memory[i]?.value ?? 0
            });
        }
        return data;
    }, [containerSeries]);

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <p className="text-muted-foreground">{t('loading')}</p>
            </div>
        );
    }

    if (prometheusDown) {
        return (
            <div className="space-y-4 p-4">
                <h1 className="text-2xl font-bold">{t('title')}</h1>
                <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4">
                    <p className="text-yellow-700 dark:text-yellow-400">{t('prometheusUnavailable')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4 p-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold">{t('title')}</h1>
                <div className="flex items-center gap-2">
                    <span
                        className={`flex items-center gap-1 text-sm ${autoRefresh ? 'text-green-600' : 'text-muted-foreground'}`}
                    >
                        <span
                            className={`inline-block h-2 w-2 rounded-full ${autoRefresh ? 'animate-pulse bg-green-500' : 'bg-gray-400'}`}
                        />
                        {autoRefresh ? t('live') : t('paused')}
                    </span>
                    <button
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                    >
                        {autoRefresh ? t('autoRefresh') + ': On' : t('autoRefresh') + ': Off'}
                    </button>
                    <button
                        onClick={handleRefresh}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                    >
                        {t('refresh')}
                    </button>
                    {lastUpdated && (
                        <span className="text-xs text-muted-foreground">
                            {t('lastUpdated')}: {lastUpdated.toLocaleTimeString()}
                        </span>
                    )}
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-border">
                {(['overview', 'containers', 'services', 'alerts', 'grafana'] as Tab[]).map((tabKey) => (
                    <button
                        key={tabKey}
                        onClick={() => setTab(tabKey)}
                        className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                            tab === tabKey
                                ? 'border-primary text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {t(tabKey)}
                        {tabKey === 'alerts' && alertCount.firing > 0 && (
                            <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-xs text-white">
                                {alertCount.firing}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Range selector (not on alerts/grafana tabs) */}
            {tab !== 'alerts' && tab !== 'grafana' && (
                <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{t('range')}:</span>
                    {RANGES.map((r) => (
                        <button
                            key={r}
                            onClick={() => setRange(r)}
                            className={`rounded px-2 py-1 text-xs ${
                                range === r
                                    ? 'bg-primary text-primary-foreground'
                                    : 'border border-border hover:bg-accent'
                            }`}
                        >
                            {t(r)}
                        </button>
                    ))}
                </div>
            )}

            {/* ---- Overview tab ---- */}
            {tab === 'overview' && overview && (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                        <KpiCard label={t('containersTotal')} value={overview.containers.total} />
                        <KpiCard label={t('containersUp')} value={overview.containers.up} color="#22c55e" />
                        <KpiCard
                            label={t('containersDown')}
                            value={overview.containers.down}
                            color={overview.containers.down > 0 ? '#ef4444' : undefined}
                        />
                        <KpiCard
                            label={t('alertsFiring')}
                            value={overview.alertsFiring}
                            color={overview.alertsFiring > 0 ? '#ef4444' : undefined}
                        />
                        <KpiCard label={t('cpuTotal')} value={formatPercent(overview.cpuTotalPercent)} />
                        <KpiCard label={t('memoryTotal')} value={formatBytes(overview.memoryTotalBytes)} />
                        <KpiCard label={t('rps')} value={overview.rps.toFixed(1)} />
                        <KpiCard
                            label={t('errorRatio')}
                            value={formatPercent(overview.errorRatio * 100)}
                            color={overview.errorRatio > 0.05 ? '#ef4444' : undefined}
                        />
                    </div>

                    {/* Container CPU overview chart */}
                    <ChartContainer title={t('cpu')}>
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={overviewChartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                <XAxis dataKey="ts" fontSize={12} />
                                <YAxis fontSize={12} unit="%" />
                                <Tooltip />
                                <Legend />
                                <Line type="monotone" dataKey="cpu" stroke="#3b82f6" name={t('cpu')} dot={false} />
                            </LineChart>
                        </ResponsiveContainer>
                    </ChartContainer>
                </div>
            )}

            {/* ---- Containers tab ---- */}
            {tab === 'containers' && (
                <div className="space-y-4">
                    {containers.length === 0 ? (
                        <p className="text-muted-foreground">{t('noContainers')}</p>
                    ) : (
                        <>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-border text-left">
                                            <th className="p-2">{t('container')}</th>
                                            <th className="p-2">{t('service')}</th>
                                            <th className="p-2">{t('cpu')}</th>
                                            <th className="p-2">{t('memory')}</th>
                                            <th className="p-2">{t('restarts')}</th>
                                            <th className="p-2">{t('probeSuccess')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {containers.map((c) => (
                                            <tr
                                                key={c.container}
                                                onClick={() => setSelectedContainer(c.container)}
                                                className={`cursor-pointer border-b border-border/50 hover:bg-accent ${
                                                    selectedContainer === c.container ? 'bg-accent' : ''
                                                }`}
                                            >
                                                <td className="p-2 font-mono text-xs">{c.container}</td>
                                                <td className="p-2">{c.service}</td>
                                                <td className="p-2">{formatPercent(c.cpuPercent)}</td>
                                                <td className="p-2">{formatBytes(c.memoryBytes)}</td>
                                                <td
                                                    className="p-2"
                                                    style={c.restarts1h > 0 ? { color: '#ef4444' } : undefined}
                                                >
                                                    {c.restarts1h}
                                                </td>
                                                <td className="p-2">
                                                    {c.probeSuccess === null ? '—' : c.probeSuccess === 1 ? '✓' : '✗'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {/* Container detail drawer */}
                            {selectedContainer && containerSeries && (
                                <div className="space-y-4 rounded-lg border border-border bg-card p-4">
                                    <h2 className="text-lg font-semibold">
                                        {selectedContainer} — {t('range')}: {t(range)}
                                    </h2>
                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                        <ChartContainer title={t('cpu')}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <LineChart
                                                    data={containerSeries.series.cpu.map((p) => ({
                                                        ts: formatTimestamp(p.ts),
                                                        value: p.value
                                                    }))}
                                                >
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                                    <XAxis dataKey="ts" fontSize={10} />
                                                    <YAxis fontSize={10} unit="%" />
                                                    <Tooltip />
                                                    <Line
                                                        type="monotone"
                                                        dataKey="value"
                                                        stroke="#3b82f6"
                                                        dot={false}
                                                    />
                                                </LineChart>
                                            </ResponsiveContainer>
                                        </ChartContainer>
                                        <ChartContainer title={t('memory')}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <AreaChart
                                                    data={containerSeries.series.memory.map((p) => ({
                                                        ts: formatTimestamp(p.ts),
                                                        value: p.value
                                                    }))}
                                                >
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                                    <XAxis dataKey="ts" fontSize={10} />
                                                    <YAxis fontSize={10} tickFormatter={formatBytes} />
                                                    <Tooltip formatter={(v) => formatBytes(Number(v))} />
                                                    <Area
                                                        type="monotone"
                                                        dataKey="value"
                                                        stroke="#8b5cf6"
                                                        fill="#8b5cf633"
                                                    />
                                                </AreaChart>
                                            </ResponsiveContainer>
                                        </ChartContainer>
                                        <ChartContainer title={t('netRx')}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <LineChart
                                                    data={containerSeries.series.netRx.map((p) => ({
                                                        ts: formatTimestamp(p.ts),
                                                        value: p.value
                                                    }))}
                                                >
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                                    <XAxis dataKey="ts" fontSize={10} />
                                                    <YAxis fontSize={10} tickFormatter={formatBytes} />
                                                    <Tooltip formatter={(v) => formatBytes(Number(v)) + '/s'} />
                                                    <Line
                                                        type="monotone"
                                                        dataKey="value"
                                                        stroke="#22c55e"
                                                        dot={false}
                                                    />
                                                </LineChart>
                                            </ResponsiveContainer>
                                        </ChartContainer>
                                        <ChartContainer title={t('netTx')}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <LineChart
                                                    data={containerSeries.series.netTx.map((p) => ({
                                                        ts: formatTimestamp(p.ts),
                                                        value: p.value
                                                    }))}
                                                >
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                                    <XAxis dataKey="ts" fontSize={10} />
                                                    <YAxis fontSize={10} tickFormatter={formatBytes} />
                                                    <Tooltip formatter={(v) => formatBytes(Number(v)) + '/s'} />
                                                    <Line
                                                        type="monotone"
                                                        dataKey="value"
                                                        stroke="#f59e0b"
                                                        dot={false}
                                                    />
                                                </LineChart>
                                            </ResponsiveContainer>
                                        </ChartContainer>
                                        <ChartContainer title={t('fsRead')}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <LineChart
                                                    data={containerSeries.series.fsRead.map((p) => ({
                                                        ts: formatTimestamp(p.ts),
                                                        value: p.value
                                                    }))}
                                                >
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                                    <XAxis dataKey="ts" fontSize={10} />
                                                    <YAxis fontSize={10} tickFormatter={formatBytes} />
                                                    <Tooltip formatter={(v) => formatBytes(Number(v)) + '/s'} />
                                                    <Line
                                                        type="monotone"
                                                        dataKey="value"
                                                        stroke="#06b6d4"
                                                        dot={false}
                                                    />
                                                </LineChart>
                                            </ResponsiveContainer>
                                        </ChartContainer>
                                        <ChartContainer title={t('fsWrite')}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <LineChart
                                                    data={containerSeries.series.fsWrite.map((p) => ({
                                                        ts: formatTimestamp(p.ts),
                                                        value: p.value
                                                    }))}
                                                >
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                                    <XAxis dataKey="ts" fontSize={10} />
                                                    <YAxis fontSize={10} tickFormatter={formatBytes} />
                                                    <Tooltip formatter={(v) => formatBytes(Number(v)) + '/s'} />
                                                    <Line
                                                        type="monotone"
                                                        dataKey="value"
                                                        stroke="#ec4899"
                                                        dot={false}
                                                    />
                                                </LineChart>
                                            </ResponsiveContainer>
                                        </ChartContainer>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            {/* ---- Services tab ---- */}
            {tab === 'services' && (
                <div className="space-y-4">
                    {services.length === 0 ? (
                        <p className="text-muted-foreground">{t('noServices')}</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border text-left">
                                        <th className="p-2">{t('service')}</th>
                                        <th className="p-2">{t('rpsLabel')}</th>
                                        <th className="p-2">{t('errorRatio')}</th>
                                        <th className="p-2">{t('p50')}</th>
                                        <th className="p-2">{t('p95')}</th>
                                        <th className="p-2">{t('p99')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {services.map((s) => (
                                        <tr key={s.service} className="border-b border-border/50 hover:bg-accent">
                                            <td className="p-2 font-mono text-xs">{s.service}</td>
                                            <td className="p-2">{s.rps.toFixed(2)}</td>
                                            <td
                                                className="p-2"
                                                style={s.errorRatio > 0.05 ? { color: '#ef4444' } : undefined}
                                            >
                                                {formatPercent(s.errorRatio * 100)}
                                            </td>
                                            <td className="p-2">{formatDuration(s.p50)}</td>
                                            <td className="p-2">{formatDuration(s.p95)}</td>
                                            <td className="p-2">{formatDuration(s.p99)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ---- Alerts tab ---- */}
            {tab === 'alerts' && (
                <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-4">
                        <KpiCard
                            label={t('firing')}
                            value={alertCount.firing}
                            color={alertCount.firing > 0 ? '#ef4444' : undefined}
                        />
                        <KpiCard
                            label={t('critical')}
                            value={alertCount.critical}
                            color={alertCount.critical > 0 ? '#ef4444' : undefined}
                        />
                        <KpiCard
                            label={t('warning')}
                            value={alertCount.warning}
                            color={alertCount.warning > 0 ? '#f59e0b' : undefined}
                        />
                    </div>
                    {alerts.length === 0 ? (
                        <p className="text-muted-foreground">{t('noAlerts')}</p>
                    ) : (
                        <div className="space-y-2">
                            {alerts.map((a) => (
                                <div
                                    key={a.id}
                                    className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
                                >
                                    <span
                                        className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full"
                                        style={{ backgroundColor: SEVERITY_COLORS[a.severity] || '#6b7280' }}
                                    />
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium">{a.alertname}</span>
                                            <span
                                                className="rounded px-1.5 py-0.5 text-xs text-white"
                                                style={{ backgroundColor: STATUS_COLORS[a.status] || '#6b7280' }}
                                            >
                                                {t(a.status as 'firing' | 'resolved' | 'pending')}
                                            </span>
                                            {a.service && (
                                                <span className="text-xs text-muted-foreground">{a.service}</span>
                                            )}
                                        </div>
                                        {a.description && (
                                            <p className="mt-1 text-sm text-muted-foreground">{a.description}</p>
                                        )}
                                        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                                            <span>
                                                {t('started')}: {formatDateTime(a.starts_at)}
                                            </span>
                                            {a.ends_at && (
                                                <span>
                                                    {t('ended')}: {formatDateTime(a.ends_at)}
                                                </span>
                                            )}
                                            {a.acknowledged_by && (
                                                <span className="text-green-600">{t('acknowledged')}</span>
                                            )}
                                        </div>
                                    </div>
                                    {a.status === 'firing' && !a.acknowledged_by && (
                                        <button
                                            onClick={() => handleAck(a.id)}
                                            className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                                        >
                                            {t('acknowledge')}
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ---- Grafana tab ---- */}
            {tab === 'grafana' && grafanaLinks && (
                <div className="space-y-4">
                    <h2 className="text-lg font-semibold">{t('grafanaDashboards')}</h2>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        {grafanaLinks.dashboards &&
                            Object.entries(grafanaLinks.dashboards).map(([key, dash]) => (
                                <div key={key} className="rounded-lg border border-border bg-card p-2">
                                    <div className="mb-2 flex items-center justify-between">
                                        <h3 className="text-sm font-medium">{key}</h3>
                                        <a
                                            href={`${grafanaLinks.grafanaPath}/d/${dash.uid}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-xs text-primary hover:underline"
                                        >
                                            {t('openInGrafana')}
                                        </a>
                                    </div>
                                    <iframe
                                        src={`${grafanaLinks.grafanaPath}/d-solo/${dash.uid}?panelId=1&from=now-1h&to=now&theme=light`}
                                        className="h-64 w-full rounded border-0"
                                        title={key}
                                    />
                                </div>
                            ))}
                    </div>
                </div>
            )}

            {error && (
                <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-4">
                    <p className="text-red-700 dark:text-red-400">
                        {t('error')}: {error}
                    </p>
                    <button onClick={handleRefresh} className="mt-2 text-sm underline">
                        {t('retry')}
                    </button>
                </div>
            )}
        </div>
    );
}
