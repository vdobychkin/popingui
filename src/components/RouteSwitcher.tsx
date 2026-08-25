import { useEffect, useRef, useState } from 'react';
import { DIRECT_ROUTE, isSystemProxy, type ProxyConfig, type Settings } from '../../shared/types.ts';

/**
 * The route the probes take. Front and centre, because on a filtered network
 * the same target gives completely different answers direct and via a proxy,
 * and a stale route silently invalidates every reading on screen.
 */
export function RouteSwitcher({
  settings,
  onSelect,
  onManage,
  onRefresh,
}: {
  settings: Settings;
  onSelect: (id: string | null) => void;
  onManage: () => void;
  /** Re-read the OS proxy settings — they can change while the app runs. */
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const active = settings.proxies.find((p) => p.id === settings.activeProxyId) ?? null;
  const viaProxy = active !== null;
  const system = settings.proxies.filter(isSystemProxy);
  const manual = settings.proxies.filter((p) => !isSystemProxy(p));

  const pick = (id: string | null) => {
    onSelect(id);
    setOpen(false);
  };

  const hint = (p: ProxyConfig) =>
    `${p.kind} · ${p.host}:${p.port}${p.username ? ' · с авторизацией' : ''}`;

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => {
          // Opening is the moment the list has to be right: the machine's proxy
          // can be switched on in Windows while this window stays open.
          if (!open) onRefresh();
          setOpen((v) => !v);
        }}
        title="Каким маршрутом идут проверки"
        className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs ${
          viaProxy
            ? 'border-warn/40 bg-warn/10 text-warn'
            : 'border-ink-700 hover:bg-ink-800 text-slate-300'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${viaProxy ? 'bg-warn' : 'bg-ink-600'}`} />
        <span className="max-w-52 truncate">{active ? active.label : DIRECT_ROUTE}</span>
        <span className="text-[9px] opacity-60">▼</span>
      </button>

      {open && (
        <div className="border-ink-700 bg-ink-900 absolute right-0 z-30 mt-1 w-80 rounded border py-1 shadow-xl">
          <Option
            label={DIRECT_ROUTE}
            hint="без посредников, как видит эту сеть система"
            selected={!viaProxy}
            onClick={() => pick(null)}
          />
          {/* The machine's own proxy first and labelled as such: it is the one
              route the user did not configure here, and picking it answers
              "does this work the way the rest of my software sees it". */}
          {system.length > 0 && (
            <>
              <div className="bg-ink-800 my-1 h-px" />
              <div className="text-muted px-3 py-1 text-[10px] uppercase tracking-wide">
                Настроен в системе
              </div>
              {system.map((p) => (
                <Option
                  key={p.id}
                  label={p.label}
                  hint={`${hint(p)} · ${p.origin ?? 'система'}`}
                  selected={p.id === settings.activeProxyId}
                  onClick={() => pick(p.id)}
                />
              ))}
            </>
          )}
          {manual.length > 0 && <div className="bg-ink-800 my-1 h-px" />}
          {manual.map((p) => (
            <Option
              key={p.id}
              label={p.label}
              hint={hint(p)}
              selected={p.id === settings.activeProxyId}
              onClick={() => pick(p.id)}
            />
          ))}
          <div className="bg-ink-800 my-1 h-px" />
          <button
            onClick={() => {
              onManage();
              setOpen(false);
            }}
            className="hover:bg-ink-800 w-full px-3 py-1.5 text-left text-xs text-slate-400"
          >
            {manual.length ? 'Управление прокси…' : 'Добавить прокси…'}
          </button>
        </div>
      )}
    </div>
  );
}

function Option({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      // The visible label lives in nested spans, which leaves the control
      // nameless for screen readers and keyboard users without this.
      aria-label={label}
      aria-current={selected}
      className={`hover:bg-ink-800 flex w-full items-start gap-2 px-3 py-1.5 text-left ${
        selected ? 'bg-ink-800/60' : ''
      }`}
    >
      <span aria-hidden className={`mt-1 text-[10px] ${selected ? 'text-good' : 'text-transparent'}`}>
        ✔
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs text-slate-200">{label}</span>
        <span className="text-muted block truncate text-[10px]">{hint}</span>
      </span>
    </button>
  );
}
