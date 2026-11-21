import { useState } from 'react';
import { fulfillOrder } from '../services/apiService';
import { Panel, Spinner } from './ui';

const ERROR_META = {
  409: { label: 'LOCK CONTENTION', hint: 'Another worker holds the row lock. No changes were made. Safe to retry.' },
  422: { label: 'ROLLBACK EXECUTED', hint: 'Transaction aborted and rolled back. No stock was modified.' },
  404: { label: 'ORDER NOT FOUND', hint: 'Verify the Order ID and try again.' },
  0:   { label: 'CONNECTION FAILED', hint: 'The API server is unreachable.' },
};

const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

export default function FulfillmentTerminal() {
  const [orderId, setOrderId] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [log, setLog] = useState([]);

  const pushLog = (kind, text) =>
    setLog((l) => [{ id: crypto.randomUUID(), kind, text, t: stamp() }, ...l].slice(0, 12));

  const submit = async (e) => {
    e.preventDefault();
    const id = orderId.trim();
    if (!id || status === 'loading') return;

    setStatus('loading');
    setResult(null);
    setError(null);
    pushLog('info', `BEGIN · fulfill ${id}`);

    try {
      const res = await fulfillOrder(id);
      setResult(res);
      setStatus('success');
      pushLog('ok', `COMMIT · ${res.order_id} · ${res.items_picked} units picked`);
    } catch (err) {
      setError(err);
      setStatus('error');
      pushLog('err', `ROLLBACK · ${id} · HTTP ${err.status || 'ERR'} ${err.code}`);
    }
  };

  const meta = error ? ERROR_META[error.status] ?? { label: 'REQUEST FAILED', hint: 'Unexpected error from the server.' } : null;
  const loading = status === 'loading';

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Panel title="Order Fulfillment Terminal" className="lg:col-span-2">
        <form onSubmit={submit} className="flex gap-2">
          <div className="flex flex-1 items-center border border-line bg-black px-3 focus-within:border-electric">
            <span className="mr-2 font-mono text-electric">&gt;</span>
            <input
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              disabled={loading}
              placeholder="ORD-1001"
              spellCheck={false}
              autoFocus
              className="w-full bg-transparent py-2 font-mono uppercase text-zinc-100 outline-none placeholder:text-zinc-700 disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !orderId.trim()}
            className="min-w-36 border border-electric bg-electric/10 px-4 font-mono text-xs uppercase tracking-wider text-electric hover:bg-electric/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? 'EXECUTING…' : 'FULFILL ORDER'}
          </button>
        </form>

        <p className="mt-2 font-mono text-[10px] text-zinc-600">
          MOCK IDS · ORD-1001 → commit · ORD-1002 → 422 · ORD-1003 → 409 · other → 404
        </p>

        <div className="mt-4 min-h-44">
          {status === 'idle' && (
            <div className="border border-dashed border-line p-4 font-mono text-xs text-zinc-600">
              AWAITING ORDER ID…
            </div>
          )}

          {loading && (
            <div className="border border-electric/50 bg-electric/5 p-4 font-mono text-xs text-electric">
              <div className="flex items-center gap-2"><Spinner /> TRANSACTION IN PROGRESS</div>
              <div className="mt-2 animate-pulse text-electric/60">
                locking rows · validating stock · writing ledger…
              </div>
            </div>
          )}

          {status === 'success' && result && (
            <div className="border border-neon/50 bg-neon/5 p-4 font-mono text-xs">
              <div className="text-sm font-bold text-neon">✓ {result.status} · COMMITTED</div>
              <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1 text-zinc-300">
                <dt className="text-zinc-500">ORDER</dt><dd>{result.order_id}</dd>
                <dt className="text-zinc-500">UNITS PICKED</dt><dd>{result.items_picked}</dd>
                <dt className="text-zinc-500">LEDGER TXNS</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {result.transaction_ids.map((t) => (
                    <span key={t} className="border border-line px-1.5 text-neon">{t}</span>
                  ))}
                </dd>
              </dl>
            </div>
          )}

          {status === 'error' && error && (
            <div className="border border-crimson/60 bg-crimson/5 p-4 font-mono text-xs">
              <div className="text-sm font-bold text-crimson">
                ✕ HTTP {error.status || 'ERR'} · {meta.label}
              </div>
              <p className="mt-2 text-zinc-300">{error.message}</p>
              <p className="mt-2 text-zinc-500">{meta.hint}</p>
              {(error.status === 409 || error.status === 0) && (
                <button
                  onClick={submit}
                  className="mt-3 border border-crimson/60 px-3 py-1 text-crimson hover:bg-crimson/10"
                >
                  RETRY
                </button>
              )}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Session Log">
        <ul className="max-h-80 space-y-1 overflow-y-auto font-mono text-[11px]">
          {log.length === 0 && <li className="text-zinc-600">NO ACTIVITY</li>}
          {log.map((l) => (
            <li
              key={l.id}
              className={l.kind === 'ok' ? 'text-neon' : l.kind === 'err' ? 'text-crimson' : 'text-electric'}
            >
              <span className="text-zinc-600">{l.t}</span> {l.text}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}