import { VERDICT_META, type TargetState } from '../../shared/types.ts';

const TONE_FILL: Record<string, string> = {
  good: 'var(--color-good)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-bad)',
  idle: 'var(--color-ink-600)',
};

/**
 * Bar height encodes latency relative to the worst sample in the window;
 * a failed probe is drawn full-height in red so outages stay visible.
 */
export function Sparkline({ history, width = 132, height = 22 }: { history: TargetState['history']; width?: number; height?: number }) {
  if (!history.length) {
    return <div className="text-muted text-[11px]" style={{ width }}>—</div>;
  }
  const slice = history.slice(-40);
  const max = Math.max(50, ...slice.map((h) => h.latency ?? 0));
  // Cap bar width so a handful of samples reads as a few ticks rather than as
  // a solid block, and keep the series pinned to the right as it fills up.
  const bw = Math.min(width / slice.length, 5);
  const offset = width - slice.length * bw;

  return (
    <svg width={width} height={height} className="overflow-visible">
      {slice.map((h, i) => {
        const tone = VERDICT_META[h.verdict].tone;
        const bad = tone === 'bad';
        const hh = bad ? height : Math.max(2, ((h.latency ?? 0) / max) * height);
        return (
          <rect
            key={`${h.ts}-${i}`}
            x={offset + i * bw}
            y={height - hh}
            width={Math.max(1, bw - 1)}
            height={hh}
            rx={1}
            fill={TONE_FILL[tone]}
            opacity={bad ? 0.85 : 0.7}
          >
            <title>
              {new Date(h.ts).toLocaleTimeString()} — {VERDICT_META[h.verdict].label}
              {h.latency != null ? ` · ${h.latency} мс` : ''}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}
