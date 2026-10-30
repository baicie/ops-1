import React from 'react';

/**
 * One icon grid for the whole shell: a 24px box with a 2px safe margin, 1.7 unit stroke,
 * round caps and joins. Every entry below is drawn to the same optical weight, so a rail of
 * ten icons reads as one set instead of ten illustrations.
 *
 * The previous set mixed 1.8px strokes with 1.5px ones, filled corners with open arcs and
 * borrowed a "no entry" circle for Governance - which only ever rendered because the
 * navigation asked for a `shield` glyph this file did not define, and the fallback painted
 * an alert triangle instead (AdminNavigation.ts:65). An unknown key still falls back, but the
 * fallback is now a neutral diamond rather than a warning.
 */
const paths: Record<string, React.ReactNode> = {
  // ── navigation ────────────────────────────────────────────────────────────────
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></>,
  plugins: <path d="M9 3.5h3.2v2.1a1.8 1.8 0 0 0 3.6 0V3.5H20v4.6h-2.1a1.8 1.8 0 0 0 0 3.6H20V20h-4.2v-2.2a1.8 1.8 0 0 0-3.6 0V20H5.5v-4.2h2.2a1.8 1.8 0 0 0 0-3.6H5.5V3.5H9Z" />,
  nodes: <><rect x="3" y="4" width="18" height="7" rx="1.8" /><rect x="3" y="13" width="18" height="7" rx="1.8" /><path d="M6.8 7.5h.01M6.8 16.5h.01M11 7.5h4M11 16.5h4" /></>,
  pipeline: <><circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="12" r="2.4" /><circle cx="6" cy="18" r="2.4" /><path d="M8.4 6h3.1a2 2 0 0 1 2 2v1.6M15.6 12h-2.1a2 2 0 0 0-2 2v1.6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.2V12l3.2 2" /></>,
  shield: <><path d="M12 3.5 19 6v5.4c0 4.2-2.9 7.5-7 9.1-4.1-1.6-7-4.9-7-9.1V6l7-2.5Z" /><path d="m9.2 12 2 2 3.6-3.8" /></>,
  access: <><rect x="4" y="10.5" width="16" height="9.5" rx="2.2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /><path d="M12 14.4v2.2" /></>,
  activity: <path d="M3 12.2h3.4l2.3-6.6 4.4 12.8 2.3-6.2H21" />,
  settings: <><path d="M4 7.5h9M17.5 7.5H20M4 16.5h3.5M12 16.5h8" /><circle cx="15" cy="7.5" r="2.4" /><circle cx="9.5" cy="16.5" r="2.4" /></>,
  ops: <><circle cx="12" cy="12" r="8.5" /><path d="M12 12h.01" /><path d="m15.6 8.4-2 4.6-4.6 2 2-4.6 4.6-2Z" /></>,
  // ── chrome and controls ───────────────────────────────────────────────────────
  menu: <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h11" />,
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  chevron: <path d="m9.5 18 6-6-6-6" />,
  down: <path d="m6 9.5 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <><path d="M20 11a8 8 0 1 0-2.4 5.7" /><path d="M20 4.5V11h-6.5" /></>,
  external: <><path d="M14 4h6v6M20 4l-8.5 8.5" /><path d="M19 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V6.5A1.5 1.5 0 0 1 5.5 5H10" /></>,
  play: <path d="M8 5.2 18.5 12 8 18.8V5.2Z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" />,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  warning: <><path d="M12 3.6 3 20.2h18L12 3.6Z" /><path d="M12 9.4v4.8M12 17.2h.01" /></>,
  alert: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.8v4.6M12 16.1h.01" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11.2v5M12 7.9h.01" /></>,
  check: <path d="m5 12.4 4.4 4.4L19 6.6" />,
  save: <><path d="M4.5 4.5h12l3 3v12h-15v-15Z" /><path d="M8 4.5v5.5h7V4.5M8 19.5v-6h8v6" /></>,
  upload: <><path d="M12 16.5V4.5M6.5 10 12 4.5 17.5 10" /><path d="M5 19.5h14" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="1.8" /><path d="M15.5 8.5V6.3A1.8 1.8 0 0 0 13.7 4.5H6.3A1.8 1.8 0 0 0 4.5 6.3v7.4a1.8 1.8 0 0 0 1.8 1.8h2.2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  moon: <path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7Z" />,
  logout: <><path d="M9.5 20.5H5.5A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1.5-1.5h4" /><path d="m16 16.5 4.5-4.5L16 7.5M20.5 12H9" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m19.5 19.5-4-4" /></>,
  file: <><path d="M13.5 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9l-5.5-5.5Z" /><path d="M13.5 3.5V9H19M8.5 13h7M8.5 16.5h4.5" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="1.8" /><rect x="3" y="13" width="18" height="7" rx="1.8" /><path d="M6.8 7.5h.01M6.8 16.5h.01" /></>,
  box: <><path d="m12 3 8 4.4-8 4.4-8-4.4L12 3Z" /><path d="m4 7.4 8 4.4v9.2l-8-4.4V7.4ZM20 7.4l-8 4.4v9.2l8-4.4V7.4Z" /></>,
  logs: <><rect x="3.5" y="4" width="17" height="16" rx="1.8" /><path d="M7.5 8.5h9M7.5 12h9M7.5 15.5h5" /></>,
  trash: <><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /></>,
  rotate: <><path d="M3.5 12a8.5 8.5 0 1 0 2.9-6.4L3.5 8" /><path d="M3.5 3v5h5" /></>,
  key: <><circle cx="8.5" cy="15" r="3.8" /><path d="m11.3 12.2 8.2-8.2M16.5 5.4l2.7 2.7M14.2 7.7l2.3 2.3" /></>,
  terminal: <><path d="m4.5 7 5.5 5-5.5 5M12.5 17.5h7" /></>,
  arrowRight: <path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5" />,
  arrowLeft: <path d="M19.5 12h-14M11 6.5 5.5 12l5.5 5.5" />,
  filter: <path d="M3.5 5.5h17l-6.6 7.6v6l-3.8 1.9v-7.9L3.5 5.5Z" />,
  inbox: <><path d="M3.5 4.5h17v15h-17v-15Z" /><path d="M3.5 13.5H8l2 2.6h4l2-2.6h4.5" /></>,
  layout: <><rect x="3.5" y="3.5" width="17" height="17" rx="2" /><path d="M3.5 9h17M9.5 9v11.5" /></>,
  // Neutral fallback: a diamond is a placeholder, not an alarm.
  unknown: <path d="m12 3.5 8.5 8.5-8.5 8.5L3.5 12 12 3.5Z" />,
};

export function Icon({ name, size = 18, className = '' }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name] || paths.unknown}
    </svg>
  );
}
