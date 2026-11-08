import { useId, type SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Back = (p: P) => (
  <Svg {...p}>
    <path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5" />
  </Svg>
);
export const Forward = (p: P) => (
  <Svg {...p}>
    <path d="M3 8h9.5M8.5 3.5 13 8l-4.5 4.5" />
  </Svg>
);
export const Reload = (p: P) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.5v3h-3" />
  </Svg>
);
export const Close = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const Star = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" />
  </Svg>
);
export const Shield = ({ off, filled, ...p }: P & { off?: boolean; filled?: boolean }) => (
  <Svg {...p}>
    <path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4z" fill={filled ? 'currentColor' : 'none'} />
    {off && <path d="M2.5 2.5l11 11" />}
  </Svg>
);
/** Stop sign with a bar: the ad blocker. */
export const AdBlock = ({ off, filled, ...p }: P & { off?: boolean; filled?: boolean }) => (
  <Svg {...p}>
    <path d="M5.6 1.9h4.8l3.7 3.7v4.8l-3.7 3.7H5.6l-3.7-3.7V5.6z" fill={filled ? 'currentColor' : 'none'} />
    {off ? <path d="M2.5 2.5l11 11" /> : <path d="M5.2 8h5.6" stroke={filled ? 'var(--icon-on-fill, #fff)' : 'currentColor'} />}
  </Svg>
);
export const Download = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
  </Svg>
);
export const Menu = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="3.5" r=".6" fill="currentColor" />
    <circle cx="8" cy="8" r=".6" fill="currentColor" />
    <circle cx="8" cy="12.5" r=".6" fill="currentColor" />
  </Svg>
);
export const Lock = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Svg>
);
export const Warning = (p: P) => (
  <Svg {...p}>
    <path d="M8 2 14.5 13.5h-13z" />
    <path d="M8 6.5v3M8 11.5v.1" />
  </Svg>
);
export const Globe = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12" />
  </Svg>
);
export const Search = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Svg>
);
export const Clock = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Svg>
);
export const Folder = (p: P) => (
  <Svg {...p}>
    <path d="M2 4.5c0-.6.4-1 1-1h3.2l1.3 1.5H13c.6 0 1 .4 1 1v6.5c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
  </Svg>
);
export const Speaker = ({ muted, ...p }: P & { muted?: boolean }) => (
  <Svg {...p}>
    <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
    {muted ? <path d="m11 6 3.5 3.5M14.5 6 11 9.5" /> : <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" />}
  </Svg>
);
export const ChevronUp = (p: P) => (
  <Svg {...p}>
    <path d="M4 10l4-4 4 4" />
  </Svg>
);
export const ChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);
export const Flag = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 14V2.5" />
    <path d="M3.5 2.8c3-1.6 5.2 1.6 9 0v6.4c-3.8 1.6-6-1.6-9 0" />
  </Svg>
);
export const Check = (p: P) => (
  <Svg {...p}>
    <path d="m3 8.5 3.2 3L13 4.5" />
  </Svg>
);
export const ArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5" />
  </Svg>
);
export const Mask = (p: P) => (
  <Svg {...p}>
    <path d="M2 6.5c0-1.5 1.2-2.5 3-2.5h6c1.8 0 3 1 3 2.5 0 2.5-1.5 4.5-3.5 4.5-1.2 0-1.8-1-2.5-1s-1.3 1-2.5 1C3.5 11 2 9 2 6.5z" />
    <circle cx="5.5" cy="7" r=".8" fill="currentColor" />
    <circle cx="10.5" cy="7" r=".8" fill="currentColor" />
  </Svg>
);
export const File = (p: P) => (
  <Svg {...p}>
    <path d="M4 1.8h5l3 3V14H4z" />
    <path d="M9 1.8V5h3" />
  </Svg>
);

/** The brand mark: a potato (same drawing as the app icon). */
export function BrandMark({ size = 24 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="9 8 100 100" aria-hidden="true">
      <defs>
        <linearGradient id={`p${id}`} x1="0.15" y1="0.1" x2="0.85" y2="0.95">
          <stop offset="0" stopColor="#EDC384" />
          <stop offset="1" stopColor="#C38B44" />
        </linearGradient>
      </defs>
      <g transform="rotate(-24 50 50)">
        <path
          d="M12 52C10 34 26 22 44 23C52 23.5 56 27 64 25C80 21 92 34 90 50C88 68 74 78 54 77C42 76.5 38 79 28 77C16 74 13 64 12 52Z"
          fill={`url(#p${id})`}
          stroke="#8A5B26"
          strokeWidth="3.5"
          strokeLinejoin="round"
        />
        <g fill="#7A4E20">
          <ellipse cx="32" cy="43" rx="3.4" ry="2.4" />
          <ellipse cx="62" cy="36" rx="3.4" ry="2.4" />
          <ellipse cx="71" cy="59" rx="3.4" ry="2.4" />
          <ellipse cx="44" cy="64" rx="3.4" ry="2.4" />
        </g>
      </g>
    </svg>
  );
}

/** An AI "sparkle" struck through. */
export function NoAi({ size = 16, strike = '#E5322D', color = 'currentColor' }: { size?: number; strike?: string; color?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="262 262 500 500" aria-hidden="true">
      <defs>
        <mask id={`m${id}`} maskUnits="userSpaceOnUse" x="262" y="262" width="500" height="500">
          <rect x="262" y="262" width="500" height="500" fill="#fff" />
          <line x1="312" y1="712" x2="712" y2="312" stroke="#000" strokeWidth="120" strokeLinecap="round" />
        </mask>
      </defs>
      <path mask={`url(#m${id})`} d="M512 262c20 145 105 230 250 250c-145 20-230 105-250 250c-20-145-105-230-250-250c145-20 230-105 250-250z" fill={color} />
      <line x1="312" y1="712" x2="712" y2="312" stroke={strike} strokeWidth="64" strokeLinecap="round" />
    </svg>
  );
}
export const Key = (p: P) => (
  <Svg {...p}>
    <circle cx="5.5" cy="10.5" r="3" />
    <path d="m7.7 8.3 5.8-5.8M11.5 4.5l1.5 1.5M9.8 6.2l1.2 1.2" />
  </Svg>
);
export const Eye = (p: P) => (
  <Svg {...p}>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);
export const EyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M6.3 3.7A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M4.3 4.9C2.5 6.1 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.1 0 2.1-.3 2.9-.8" />
    <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8M2 2l12 12" />
  </Svg>
);
export const Copy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
  </Svg>
);
