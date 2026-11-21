import { useState } from 'react';
import { getTransactions } from '../services/apiService';
import { useApi } from '../hooks/useApi';
import { ErrorLine, Panel, Spinner, fmtTime } from './ui';

const LIMIT = 15;
const REASON_STYLE = {
  PICK: 'text-electric border-electric/40',
  RESTOCK: 'text-neon border-neon/40',
  DAMAGE: 'text-crimson border-crimson/40',
};

export default function Ledger() {
  const [page, setPage] = useState(1);
  const { data, error, loading, refetch } = useApi(() => getTransactions(page, LIMIT), [page]);

  const totalPages = data?.total_pages ?? 1;
  const btn =
    'border border-line px-3 py-1 font-mono text-xs hover:border-electric hover:text-electric disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-line disabled:hover:text-inherit';

  return (
    <Panel
      title="Inventory Ledger · Immutable Audit Trail"
      right={
        <span className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
          {loading && <Spinner />}
          {data ? `${data.total} ROWS · READ-ONLY` : '…'}
        </span>
      }
    >
      {error && <ErrorLine error={error} onRetry={refetch} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse font-mono text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-widest text-zinc-500">
              <th className="py-2 pr-4 font-normal">Transaction ID</th>
              <th className="py-2 pr-4 font-normal">SKU</th>
              <th className="py-2 pr-4 font-normal">Bin</th>
              <th className="py-2 pr-4 text-right font-normal">Qty Δ</th>
              <th className="py-2 pr-4 font-normal">Reason</th>
              <th className="py-2 font-normal">Timestamp</th>
            </tr>
          </thead>
          <tbody className={loading ? 'opacity-50' : ''}>
            {data?.data.map((t) => (
              <tr key={t.transaction_id} className="border-b border-line/60 hover:bg-white/[0.02]">
                <td className="py-1.5 pr-4 text-zinc-100">{t.transaction_id}</td>
                <td className="py-1.5 pr-4">{t.sku}</td>
                <td className="py-1.5 pr-4 text-zinc-400">{t.bin_id}</td>
                <td className={`py-1.5 pr-4 text-right font-bold ${t.quantity_change > 0 ? 'text-neon' : 'text-crimson'}`}>
                  {t.quantity_change > 0 ? '+' : ''}{t.quantity_change}
                </td>
                <td className="py-1.5 pr-4">
                  <span className={`border px-1.5 py-0.5 text-[10px] ${REASON_STYLE[t.reason] ?? 'border-line text-zinc-400'}`}>
                    {t.reason}
                  </span>
                </td>
                <td className="py-1.5 text-zinc-500">{fmtTime(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="font-mono text-[11px] text-zinc-500">PAGE {page} / {totalPages}</span>
        <div className="flex gap-2">
          <button className={btn} onClick={() => setPage(1)} disabled={page === 1 || loading}>« FIRST</button>
          <button className={btn} onClick={() => setPage((p) => p - 1)} disabled={page === 1 || loading}>‹ PREV</button>
          <button className={btn} onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages || loading}>NEXT ›</button>
        </div>
      </div>
    </Panel>
  );
}