import type { SVGProps } from 'react';
import type { Verdict } from '../../shared/types.ts';

/**
 * Hand-rolled instead of an icon package: the app needs about a dozen glyphs,
 * and inlining them keeps the bundle free of a dependency whose whole value
 * would be the parts we do not use. Every icon draws on a 16-unit grid with
 * `currentColor`, so colour comes from the surrounding text class.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // shrink-0 matters in flex rows: an icon must never be squeezed narrower
      // than its box when a neighbouring label grows.
      className="shrink-0"
      {...rest}
    >
      {children}
    </svg>
  );
}

/**
 * A cogwheel, not a sunburst: the teeth are drawn as one closed outline so the
 * shape still reads as a gear at 14 px, where eight detached spokes read as a
 * star instead.
 */
export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <path
      d="M6.7 1.6h2.6l.35 1.62 1.1.64 1.55-.55 1.3 2.25-1.2 1.11v1.26l1.2 1.11-1.3 2.25-1.55-.55-1.1.64-.35 1.62H6.7l-.35-1.62-1.1-.64-1.55.55-1.3-2.25 1.2-1.11V7.17l-1.2-1.11 1.3-2.25 1.55.55 1.1-.64z"
      strokeWidth={1.2}
      strokeLinejoin="round"
    />
    <circle cx="8" cy="8" r="2.05" strokeWidth={1.2} />
  </Svg>
);

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.6a4 4 0 0 1 8 0c0 2.6.7 3.7 1.3 4.3H2.7C3.3 10.3 4 9.2 4 6.6z" />
    <path d="M6.6 12.9a1.6 1.6 0 0 0 2.8 0" />
  </Svg>
);

/** Same bell, struck through — off must be readable without relying on colour. */
export const IconBellOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.6a4 4 0 0 1 8 0c0 2.6.7 3.7 1.3 4.3H2.7C3.3 10.3 4 9.2 4 6.6z" />
    <path d="M6.6 12.9a1.6 1.6 0 0 0 2.8 0" />
    <path d="m2.4 2.4 11.2 11.2" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3.2 12.5 8 5 12.8z" fill="currentColor" strokeWidth={1.2} />
  </Svg>
);

export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" strokeWidth={1.2} />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="m5.2 8.2 1.9 1.9 3.7-4" />
  </Svg>
);

export const IconWarn = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2 14.5 13.4h-13z" />
    <path d="M8 6.4v3M8 11.4h.01" />
  </Svg>
);

export const IconBan = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="m3.9 3.9 8.2 8.2" />
  </Svg>
);

export const IconDot = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
  </Svg>
);

/** DNS answer swapped for another: two paths crossing. */
export const IconSwap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 5h7.5l-2-2M13.5 11H6l2 2" />
    <path d="M11.5 3 14 5l-2.5 2" />
  </Svg>
);

/** Connection cut mid-flight: a link broken in the middle. */
export const IconCut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.4 9.6 4.8 11.2a2.5 2.5 0 0 1-3.5-3.5l1.6-1.6M9.6 6.4l1.6-1.6a2.5 2.5 0 0 1 3.5 3.5l-1.6 1.6" />
    <path d="m6.6 6.6 2.8 2.8" strokeDasharray="1.5 1.6" />
  </Svg>
);

/** Certificate that is not what it claims to be. */
export const IconShieldAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.6 13.2 3.6v4.2c0 3.1-2.1 5.4-5.2 6.6-3.1-1.2-5.2-3.5-5.2-6.6V3.6z" />
    <path d="M8 5.4v3M8 10.6h.01" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.4V8l2.4 1.6" />
  </Svg>
);

/** Answer arrived, but the page is not the resource. */
export const IconPage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 2.2h5.6L12.4 5v8.8H3.6z" />
    <path d="M6 8.4h4M6 10.8h2.6" />
  </Svg>
);

/**
 * Datagrams that do not arrive: a dotted trail — UDP has no connection to draw
 * — stopped by a wall, with nothing on the far side.
 */
export const IconPacketsBlocked = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.6 8h.01M4.4 8h.01M7.2 8h.01" strokeWidth={2.2} />
    <path d="M10.4 3.4v9.2" />
    <path d="M12.8 5.6 10.4 8l2.4 2.4" />
  </Svg>
);

export const IconHelp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M6.4 6.2a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1v.3M8 11.6h.01" />
  </Svg>
);

/** Which glyph stands for each verdict. Distinct shapes, not only colours. */
export const VERDICT_ICON: Record<Verdict, (p: IconProps) => React.JSX.Element> = {
  ok: IconCheck,
  'ok-no-icmp': IconCheck,
  'dns-nxdomain': IconHelp,
  'dns-hijack': IconSwap,
  'ip-block': IconBan,
  'tls-block': IconCut,
  'tls-mitm': IconShieldAlert,
  'tls-expired': IconClock,
  'tls-expiring': IconClock,
  'content-mismatch': IconPage,
  'http-stub': IconPage,
  'http-error': IconWarn,
  'udp-silent': IconPacketsBlocked,
  timeout: IconClock,
  error: IconWarn,
  pending: IconDot,
};

/** Tone glyphs for the header counters. */
export const TONE_ICON = {
  good: IconCheck,
  warn: IconWarn,
  bad: IconBan,
  idle: IconDot,
} as const;
