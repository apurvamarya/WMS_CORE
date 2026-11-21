export function Panel({ title, right, children, className = '' }) {
  return (
    <section className={`flex flex-col border border-line bg-panel ${className}`}>
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-[11px] uppercase tracking-widest text-zinc-500">{title}</h2>
        {right}
      </header>
      <div className="min-h-0 flex-1 p-3">{children}</div>
    </section>
  );
}

export const Spinner = ({ className = '' }) => (
  <span
    className={`inline-block h-3 w-3 animate-spin rounded-full border-2 border-electric border-t-transparent ${className}`}
  />
);

export const ErrorLine = ({ error, onRetry }) => (
  <div className="flex items-center justify-between border border-crimson/50 bg-crimson/5 px-3 py-2 font-mono text-xs text-crimson">
    <span>
      {error.status ? `HTTP ${error.status}` : 'ERR'} · {error.code}: {error.message}
    </span>
    {onRetry && (
      <button onClick={onRetry} className="ml-3 border border-crimson/60 px-2 py-0.5 hover:bg-crimson/10">
        RETRY
      </button>
    )}
  </div>
);

export const fmtTime = (iso) =>
  new Date(iso).toLocaleString('en-GB', { hour12: false, dateStyle: 'short', timeStyle: 'medium' });