import { useState } from 'react';
import { isSystemProxy, type Settings } from '../../shared/types.ts';
import type { ProxyTest } from '../lib/useMonitor.ts';

export function ProxyPanel({
  settings,
  onAdd,
  onRemove,
  onTest,
  onSelect,
  onClose,
}: {
  settings: Settings;
  onAdd: (text: string) => Promise<number>;
  onRemove: (id: string) => Promise<void>;
  onTest: (id: string) => Promise<ProxyTest>;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ProxyTest | 'running'>>({});

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const added = await onAdd(text);
      if (added === 0) setError('Ничего не добавлено: строки не распознаны или такие прокси уже есть.');
      else setText('');
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: 'running' }));
    const result = await onTest(id);
    setTests((t) => ({ ...t, [id]: result }));
  };

  return (
    <div className="border-ink-800 bg-ink-900 border-b px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted text-[10px] uppercase tracking-wide">Прокси</span>
        <button onClick={onClose} className="text-muted ml-auto text-xs hover:text-slate-300">
          Свернуть
        </button>
      </div>

      {settings.proxies.length > 0 && (
        <ul className="mb-3 space-y-1">
          {settings.proxies.map((p) => {
            const t = tests[p.id];
            const activeHere = p.id === settings.activeProxyId;
            const fromSystem = isSystemProxy(p);
            return (
              <li
                key={p.id}
                className={`border-ink-800 bg-ink-950/60 flex items-center gap-2 rounded border px-2.5 py-1.5 ${
                  activeHere ? 'border-warn/40' : ''
                }`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeHere ? 'bg-warn' : 'bg-ink-600'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-slate-200">{p.label}</span>
                  <span className="text-muted block truncate font-mono text-[10px]">
                    {p.kind} · {p.host}:{p.port}
                    {p.username ? ' · с авторизацией' : ''}
                    {fromSystem ? ` · ${p.origin ?? 'система'}` : ''}
                  </span>
                </span>

                {t === 'running' && <span className="text-muted text-[11px]">проверяю…</span>}
                {t && t !== 'running' && (
                  <span
                    title={t.error ?? ''}
                    className={`max-w-56 truncate text-[11px] ${t.ok ? 'text-good' : 'text-bad'}`}
                  >
                    {t.ok ? `работает, ${t.ms} мс` : `не работает: ${t.error ?? 'ошибка'}`}
                  </span>
                )}

                <button
                  onClick={() => void test(p.id)}
                  className="border-ink-700 hover:bg-ink-800 rounded border px-2 py-1 text-[11px] text-slate-300"
                >
                  Проверить
                </button>
                {!activeHere && (
                  <button
                    onClick={() => onSelect(p.id)}
                    className="border-ink-700 hover:bg-ink-800 rounded border px-2 py-1 text-[11px] text-slate-300"
                  >
                    Использовать
                  </button>
                )}
                {/* System entries mirror the OS and are re-read at every start,
                    so deleting one here would only make it come back. */}
                {fromSystem ? (
                  <span className="text-muted px-2 py-1 text-[11px]" title="Читается из настроек системы">
                    из системы
                  </span>
                ) : (
                  <button
                    onClick={() => void onRemove(p.id)}
                    title="Удалить"
                    className="border-bad/40 text-bad hover:bg-bad/10 rounded border px-2 py-1 text-[11px]"
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={'socks5://127.0.0.1:1080  Локальный SOCKS\nhttp://user:pass@proxy.example:3128  Рабочий HTTP\n127.0.0.1:9050  Tor'}
        className="border-ink-700 bg-ink-950 placeholder:text-muted focus:border-ink-600 w-full rounded border px-3 py-2 font-mono text-xs text-slate-200 outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={!text.trim() || busy}
          className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-40"
        >
          Добавить
        </button>
        <span className="text-muted text-[11px]">
          Схемы: socks5, socks4, http. Без схемы — socks5. Логин и пароль в URL. Текст после адреса — название.
        </span>
      </div>
      {error && <div className="text-bad mt-2 text-[11px]">{error}</div>}
      <div className="text-muted mt-2 text-[11px]">
        Через прокси имя резолвит сам прокси. ICMP не туннелируется, поэтому слой ping измеряет полный
        круг до цели по TCP: туннель открывается отдельно и во время не входит.
      </div>
    </div>
  );
}
