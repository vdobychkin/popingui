import { LAYER_HINT, LAYER_LABEL, LAYER_ORDER, type LayerSet } from '../../shared/types.ts';

/**
 * Which probes to run, as a row of checkboxes. One component for all three
 * places that ask the question — adding a target, editing one, and the default
 * for new targets — so the wording and the hints cannot drift apart.
 */
export function LayerPicker({
  value,
  onChange,
  requireOne = false,
  className = '',
}: {
  value: LayerSet;
  onChange: (next: LayerSet) => void;
  /**
   * Refuse to switch off the last remaining layer. Set when editing a target
   * that already exists: a target with nothing to run would sit in the list
   * being probed forever and reporting nothing.
   */
  requireOne?: boolean;
  className?: string;
}) {
  const enabled = LAYER_ORDER.filter((l) => value[l]);
  const lastOne = requireOne && enabled.length === 1;

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      {LAYER_ORDER.map((l) => {
        // Disabled rather than hidden, and only for the one box that would empty
        // the set — the checkbox stays where the eye expects it.
        const locked = lastOne && value[l];
        return (
          <label
            key={l}
            title={locked ? 'Хотя бы один слой должен остаться включённым' : LAYER_HINT[l]}
            className={`flex items-center gap-1.5 text-xs text-slate-300 ${
              locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              checked={value[l]}
              disabled={locked}
              onChange={(e) => onChange({ ...value, [l]: e.target.checked })}
              className="accent-good"
            />
            <span className="font-mono">{LAYER_LABEL[l]}</span>
          </label>
        );
      })}
    </div>
  );
}
