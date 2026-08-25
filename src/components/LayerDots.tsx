import { LAYER_LABEL, LAYER_ORDER, type LayerResult, type LayerStatus } from '../../shared/types.ts';

const ORDER = LAYER_ORDER;
const LABEL = LAYER_LABEL;
const STYLE: Record<LayerStatus, string> = {
  ok: 'bg-good/15 text-good border-good/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  fail: 'bg-bad/15 text-bad border-bad/30',
  skip: 'bg-ink-800 text-muted border-ink-700',
};

/** Compact five-slot strip: the whole diagnosis at a glance, in probe order. */
export function LayerDots({ layers }: { layers: LayerResult[] }) {
  const byName = new Map(layers.map((l) => [l.layer, l]));
  return (
    <div className="flex gap-1">
      {ORDER.map((name) => {
        const l = byName.get(name);
        const status: LayerStatus = l?.status ?? 'skip';
        return (
          <span
            key={name}
            title={l ? `${LABEL[name]}: ${l.detail}${l.ms != null ? ` (${l.ms} мс)` : ''}` : `${LABEL[name]}: —`}
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none tracking-tight ${STYLE[status]}`}
          >
            {LABEL[name]}
          </span>
        );
      })}
    </div>
  );
}
