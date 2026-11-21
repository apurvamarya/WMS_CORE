import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { getAlerts, getTrends } from '../services/apiService';
import { useApi } from '../hooks/useApi';
import { ErrorLine, Panel, Spinner, fmtTime } from './ui';

const AXIS = { fontSize: 10, fill: '#71717a', fontFamily: 'JetBrains Mono, monospace' };

function TrendsChart() {
  const { data, error, loading, refetch } = useApi(() => getTrends(30));

  return (
    <Panel
      title="Stock Depletion Trends · 30d"
      right={loading && <Spinner />}
      className="xl:col-span-2"
    >
      {error && <ErrorLine error={error} onRetry={refetch} />}
      {/* Parent needs an explicit height for ResponsiveContainer */}
      <div className="h-80 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="#161616" vertical={false} />
            <XAxis dataKey="date" tick={AXIS} tickFormatter={(d) => d.slice(5)} stroke="#262626" minTickGap={24} />
            <YAxis tick={AXIS} stroke="#262626" />
            <Tooltip
              contentStyle={{ background: '#000', border: '1px solid #262626', borderRadius: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}
              labelStyle={{ color: '#a1a1aa' }}
              cursor={{ stroke: '#2f7bff', strokeOpacity: 0.4 }}
            />
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }} />
            <Line type="monotone" dataKey="depleted" name="Depleted" stroke="#2f7bff" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
            <Line type="monotone" dataKey="restocked" name="Restocked" stroke="#39ff14" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function AlertsPanel() {
  const { data, error, loading, refetch } = useApi(getAlerts);

  return (
    <Panel
      title="Critical Restock Alerts"
      right={
        loading ? <Spinner /> : (
          <span className="font-mono text-[11px] text-crimson">{data?.length ?? 0} ACTIVE</span>
        )
      }
    >
      {error && <ErrorLine error={error} onRetry={refetch} />}
      <ul className="max-h-80 space-y-2 overflow-y-auto">
        {data?.map((a) => {
          const pct = Math.min(100, (a.current_qty / a.reorder_threshold) * 100);
          return (
            <li key={a.alert_id} className="border border-line p-2">
              <div className="flex items-baseline justify-between font-mono">
                <span className="text-zinc-100">{a.sku}</span>
                <span className="text-crimson">
                  {a.current_qty}<span className="text-zinc-600"> / {a.reorder_threshold}</span>
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-zinc-500">{a.product_name}</div>
              <div className="mt-2 h-0.5 w-full bg-zinc-900">
                <div className="h-full bg-crimson" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-600">
                <span>BIN {a.bin_id}</span>
                <span>#{a.alert_id} · {fmtTime(a.created_at)}</span>
              </div>
            </li>
          );
        })}
        {data?.length === 0 && <li className="font-mono text-xs text-neon">ALL STOCK ABOVE THRESHOLD</li>}
      </ul>
    </Panel>
  );
}

export default function Dashboard() {
  return (
    <div className="grid gap-3 xl:grid-cols-3">
      <TrendsChart />
      <AlertsPanel />
    </div>
  );
}