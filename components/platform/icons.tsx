import type { SVGProps } from "react";

/*
 * Inline stroke icons for the platform (super-admin) shell and dashboards.
 * Heroicons-style outlines at strokeWidth 1.75, matching the icons already
 * used across the portal. Server-safe: no client JavaScript, purely
 * decorative (`aria-hidden` by default) — every usage site pairs the icon
 * with a visible text label.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
    </Svg>
  );
}

export function BuildingIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 21h18" />
      <path d="M5 21V8l7-4 7 4v13" />
      <path d="M10 21v-5h4v5" />
      <path d="M9 11h.01M15 11h.01" />
    </Svg>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5" />
      <path d="M16 8.5a3 3 0 10-1.5-5.6" />
      <path d="M17 14c2.3.4 4.1 2.2 4.5 5" />
    </Svg>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </Svg>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
      <path d="M10 12h4" />
    </Svg>
  );
}

export function ChartIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 3v16a2 2 0 002 2h16" />
      <path d="M8 15l3-4 3 2 4-6" />
    </Svg>
  );
}

export function CardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

export function HeartPulseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12h4l2 6 4-12 2 6h6" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.11-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.56-1.03H3a2 2 0 110-4h.09a1.7 1.7 0 001.56-1.11 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34h.01a1.7 1.7 0 001.03-1.56V3a2 2 0 114 0v.09a1.7 1.7 0 001.03 1.56 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v.01a1.7 1.7 0 001.56 1.03H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.51 1.03z" />
    </Svg>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 010 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.2" />
    </Svg>
  );
}

export function MegaphoneIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 10v4a1 1 0 001 1h2l4 4V5L6 9H4a1 1 0 00-1 1z" />
      <path d="M14 8a5 5 0 010 8" />
      <path d="M17 5a9 9 0 010 14" />
    </Svg>
  );
}

export function QuestionIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 3.5" />
      <path d="M12 16.5h.01" />
    </Svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" />
      <path d="M10 20a2 2 0 004 0" />
    </Svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5h16l-6 7v6l-4 2v-8L4 5z" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </Svg>
  );
}

export function CollapseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M13 4v16" />
      <path d="m10 9-2 3 2 3" />
    </Svg>
  );
}

/** PrepGrade graduation-cap brand mark (solid, for the sidebar logo tile). */
export function CapIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M12 3l8 4-8 4-8-4 8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 16.5l8 4 8-4" />
    </Svg>
  );
}
