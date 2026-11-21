import { useState } from 'react';
import Dashboard from './components/Dashboard';
import FulfillmentTerminal from './components/FulfillmentTerminal';
import Ledger from './components/Ledger';
import { USE_MOCK } from './services/apiService';

const VIEWS = [
  { id: 'dashboard', label: 'Analytics', icon: '▦', Component: Dashboard },
  { id: 'fulfill', label: 'Fulfillment', icon: '⌁', Component: FulfillmentTerminal },
  { id: 'ledger', label: 'Ledger', icon: '≡', Component: Ledger },
];

export default function App() {
  const [view, setView] = useState('dashboard');
  const active = VIEWS.find((v) => v.id === view);

  return (
    <div className="flex h-full bg-oled">
      <aside className="flex w-48 shrink-0 flex-col border-r border-line bg-panel">
        <div className="border-b border-line px-4 py-3">
          <div className="font-mono text-sm font-bold tracking-widest text-zinc-100">WMS<span className="text-electric">_</span>CORE</div>
          <div className="font-mono text-[10px] text-zinc-600">POSTGRES · ACID</div>
        </div>

        <nav className="flex-1 py-2">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`flex w-full items-center gap-3 border-l-2 px-4 py-2 text-left text-xs uppercase tracking-wider transition-colors ${
                view === v.id
                  ? 'border-electric bg-electric/10 text-electric'
                  : 'border-transparent text-zinc-500 hover:text-zinc-200'
              }`}
            >
              <span className="font-mono">{v.icon}</span>
              {v.label}
            </button>
          ))}
        </nav>

        <div className="border-t border-line px-4 py-3 font-mono text-[10px]">
          <span className={USE_MOCK ? 'text-crimson' : 'text-neon'}>●</span>{' '}
          <span className="text-zinc-500">API: {USE_MOCK ? 'MOCK' : 'LIVE'}</span>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-3">
        <h1 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-zinc-600">
          / {active.label}
        </h1>
        <active.Component />
      </main>
    </div>
  );
}