"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  ArchiveIcon,
  BuildingIcon,
  CardIcon,
  ChartIcon,
  CollapseIcon,
  DocumentIcon,
  GridIcon,
  HeartPulseIcon,
  HomeIcon,
  MegaphoneIcon,
  QuestionIcon,
  SettingsIcon,
  ShieldIcon,
  TagIcon,
  UsersIcon,
} from "./icons";

/**
 * Navigation for the platform (super-admin) area — dark shell per the
 * PrepGrade super-admin design reference.
 *
 * Same honesty contract as before (prompt 31): items whose route hasn't been
 * built use `href: null` and render as non-interactive, dimmed rows with a
 * truthful "Not yet available" tooltip — never as dead links implying a
 * finished capability. Today only Dashboard, Institutions, and Audit Logs
 * have real routes; the remaining rows preview the planned IA so the shell
 * matches the approved design without pretending features exist.
 */
type NavItem = {
  label: string;
  href: string | null;
  icon: React.ReactNode;
  /** Optional sub-routes shown when the parent section is expanded. */
  children?: { label: string; href: string | null }[];
};

const mainNav: NavItem[] = [
  { label: "Dashboard", href: "/platform", icon: <HomeIcon /> },
  {
    label: "Institutions",
    href: "/platform/institutions",
    icon: <BuildingIcon />,
    children: [
      { label: "All Institutions", href: "/platform/institutions" },
      { label: "Add Institution", href: null },
      { label: "Pending Approvals", href: null },
      { label: "Subscription Plans", href: null },
      { label: "Usage & Activity", href: null },
    ],
  },
  { label: "Users", href: null, icon: <UsersIcon /> },
  { label: "Assessments", href: null, icon: <DocumentIcon /> },
  { label: "Question Bank", href: null, icon: <GridIcon /> },
  { label: "Analytics", href: null, icon: <ChartIcon /> },
  { label: "Billing & Subscriptions", href: null, icon: <CardIcon /> },
  { label: "Moderation", href: null, icon: <ShieldIcon /> },
  { label: "System Health", href: null, icon: <HeartPulseIcon /> },
  { label: "Settings", href: null, icon: <SettingsIcon /> },
];

const platformNav: NavItem[] = [
  { label: "Plans & Features", href: null, icon: <TagIcon /> },
  { label: "Payment History", href: null, icon: <CardIcon /> },
  { label: "Audit Logs", href: "/platform/audit", icon: <ArchiveIcon /> },
  { label: "Announcements", href: null, icon: <MegaphoneIcon /> },
  { label: "Help & Support", href: null, icon: <QuestionIcon /> },
];

function isActive(href: string | null, pathname: string): boolean {
  if (href === null) return false;
  return (
    pathname === href ||
    // Keep "Dashboard" inactive on sibling routes like /platform/audit.
    (href !== "/platform" && pathname.startsWith(`${href}/`))
  );
}

function NavRow({
  item,
  pathname,
  collapsed,
  expanded,
  onToggleExpand,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const active = isActive(item.href, pathname);
  const isDisabled = item.href === null;
  const hasChildren = Boolean(item.children?.length);

  const rowClasses = cn(
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
    collapsed && "justify-center px-0",
    active
      ? "bg-brand text-white"
      : isDisabled
        ? "cursor-not-allowed text-white/45"
        : "text-white/70 hover:bg-white/5 hover:text-white",
  );

  const row = (
    <>
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5">{item.icon}</span>
      {!collapsed ? <span className="min-w-0 flex-1 text-left">{item.label}</span> : null}
      {!collapsed && hasChildren ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn("h-4 w-4 shrink-0 transition-transform", expanded && "rotate-90")}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      ) : null}
    </>
  );

  return (
    <li>
      {isDisabled ? (
        // Planned section — labelled honestly, never a dead link.
        <span className={rowClasses} aria-disabled="true" title="Not yet available — planned for a later phase">
          {row}
        </span>
      ) : hasChildren && !collapsed ? (
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className={rowClasses}
        >
          {row}
        </button>
      ) : (
        <Link
          href={item.href!}
          className={rowClasses}
          aria-current={active ? "page" : undefined}
          title={collapsed ? item.label : undefined}
        >
          {row}
        </Link>
      )}

      {!collapsed && hasChildren && expanded ? (
        <ul className="mt-0.5 flex flex-col gap-0.5 pl-11">
          {item.children!.map((child) => {
            const childActive = isActive(child.href, pathname);
            const childClasses = cn(
              "flex w-full items-center rounded-lg px-3 py-1.5 text-left text-sm transition-colors",
              childActive
                ? "bg-brand-700 font-medium text-white"
                : child.href === null
                  ? "cursor-not-allowed text-white/40"
                  : "text-white/60 hover:bg-white/5 hover:text-white",
            );
            return (
              <li key={child.label}>
                {child.href === null ? (
                  <span className={childClasses} aria-disabled="true" title="Not yet available — planned for a later phase">
                    {child.label}
                  </span>
                ) : (
                  <Link href={child.href} className={childClasses}>
                    {child.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function NavSection({
  heading,
  items,
  pathname,
  collapsed,
  expandedLabel,
  onToggleExpand,
}: {
  heading?: string;
  items: NavItem[];
  pathname: string;
  collapsed: boolean;
  expandedLabel: string | null;
  onToggleExpand: (label: string) => void;
}) {
  return (
    <nav aria-label={heading || "Platform navigation"}>
      {heading ? (
        <p
          className={cn(
            "px-3 pb-1 text-2xs font-semibold uppercase tracking-wider text-white/35",
            collapsed && "text-center",
          )}
        >
          {collapsed ? "—" : heading}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <NavRow
            key={item.label}
            item={item}
            pathname={pathname}
            collapsed={collapsed}
            expanded={expandedLabel === item.label}
            onToggleExpand={() => onToggleExpand(item.label)}
          />
        ))}
      </ul>
    </nav>
  );
}

export function PlatformSidebar({ userName }: { userName: string }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  // The Institutions group starts open when the current route lives under it,
  // mirroring the expanded submenu in the design reference.
  const [expandedLabel, setExpandedLabel] = useState<string | null>(() =>
    pathname.startsWith("/platform/institutions") ? "Institutions" : null,
  );

  const toggleExpand = (label: string) =>
    setExpandedLabel((current) => (current === label ? null : label));

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col bg-ink transition-[width]",
        collapsed ? "w-[72px]" : "w-60",
      )}
    >
      {/* Brand header */}
      <div
        className={cn(
          "flex items-center gap-3 px-4 pt-5",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-5 w-5"
          >
            <path d="M12 3l8 4-8 4-8-4 8-4z" />
            <path d="M4 12l8 4 8-4" />
            <path d="M4 16.5l8 4 8-4" />
          </svg>
        </div>
        {!collapsed ? (
          <div className="flex flex-col gap-1">
            <span className="text-lg font-bold tracking-tight text-white">
              PrepGrade
            </span>
            <span className="w-fit rounded-md bg-brand px-2 py-0.5 text-2xs font-semibold text-white">
              Super Admin
            </span>
          </div>
        ) : null}
      </div>

      {/* Navigation */}
      <div className="mt-6 flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        <NavSection
          items={mainNav}
          pathname={pathname}
          collapsed={collapsed}
          expandedLabel={expandedLabel}
          onToggleExpand={toggleExpand}
        />

        <NavSection
          heading="Platform"
          items={platformNav}
          pathname={pathname}
          collapsed={collapsed}
          expandedLabel={expandedLabel}
          onToggleExpand={toggleExpand}
        />
      </div>

      {/* Workspace footer — app identity + collapse control. The signed-in
          account stays reachable via the top-right profile menu. */}
      <div className="px-3 pb-4">
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/5 p-3",
            collapsed && "justify-center p-2",
          )}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-4 w-4"
            >
              <path d="M12 3l8 4-8 4-8-4 8-4z" />
              <path d="M4 12l8 4 8-4" />
              <path d="M4 16.5l8 4 8-4" />
            </svg>
          </div>
          {!collapsed ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">PrepGrade</p>
              <p className="text-2xs text-white/50">v1.0.0 · {userName}</p>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <CollapseIcon className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
          </button>
        </div>
      </div>
    </aside>
  );
}
