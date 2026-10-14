"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./button";

/*
 * Dependency-free dropdown menu (row actions, account menus). Implements the
 * WAI-ARIA menu pattern: trigger with aria-haspopup/expanded, role="menu"
 * panel, roving Arrow/Home/End focus between role="menuitem" entries, Escape
 * to close and refocus the trigger, and pointer-down outside dismissal.
 */

type DropdownContextValue = {
  close: () => void;
};

const DropdownContext = createContext<DropdownContextValue | null>(null);

const ITEM_SELECTOR = "[data-menu-item]:not([disabled])";

export type DropdownProps = {
  /** Visible trigger content, e.g. "Actions". */
  label: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  variant?: ButtonVariant;
  size?: ButtonSize;
  triggerClassName?: string;
  className?: string;
};

export function Dropdown({
  label,
  children,
  align = "start",
  variant = "secondary",
  size = "sm",
  triggerClassName,
  className,
}: DropdownProps) {
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const menuId = `${baseId}-menu`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const close = useCallback((refocusTrigger = false) => {
    setOpen(false);
    if (refocusTrigger) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    setOpen(true);
  }, []);

  // Focus the first enabled item when the menu opens.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(ITEM_SELECTOR);
    first?.focus();
  }, [open]);

  // Dismiss on any pointer interaction outside the trigger/menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      openMenu();
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      // Leave the menu but keep natural focus order.
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();

    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    if (event.key === "ArrowDown") {
      nextIndex = current === items.length - 1 ? 0 : current + 1;
    } else if (event.key === "ArrowUp") {
      nextIndex = current <= 0 ? items.length - 1 : current - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  };

  return (
    <DropdownContext.Provider value={{ close: () => close(true) }}>
      <div className={cn("relative inline-block", className)}>
        <button
          ref={triggerRef}
          type="button"
          id={triggerId}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => (open ? close() : openMenu())}
          onKeyDown={handleTriggerKeyDown}
          className={buttonClasses(variant, size, triggerClassName)}
        >
          {label}
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              open && "rotate-180",
            )}
          >
            <path
              d="m4 6 4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {open ? (
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            onKeyDown={handleMenuKeyDown}
            className={cn(
              "absolute z-20 mt-1 min-w-48 animate-pop-in rounded-field",
              "border border-border bg-surface p-1 shadow-raised",
              align === "end" ? "right-0" : "left-0",
            )}
          >
            {children}
          </div>
        ) : null}
      </div>
    </DropdownContext.Provider>
  );
}

export type DropdownItemProps = {
  children: ReactNode;
  onClick?: () => void;
  /** Destructive actions (delete, remove) render in the danger tone. */
  destructive?: boolean;
  disabled?: boolean;
  /** Optional leading icon element (inline SVG, aria-hidden by convention). */
  icon?: ReactNode;
};

export function DropdownItem({
  children,
  onClick,
  destructive,
  disabled,
  icon,
}: DropdownItemProps) {
  const context = useContext(DropdownContext);

  const handleClick = () => {
    onClick?.();
    context?.close();
  };

  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item
      disabled={disabled}
      onClick={handleClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5",
        "text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        destructive
          ? "text-danger-strong hover:bg-danger-soft"
          : "text-ink hover:bg-surface-muted",
      )}
    >
      {icon ? <span aria-hidden="true" className="shrink-0">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** Visual group separator; role="presentation" keeps it out of AT menus. */
export function DropdownSeparator() {
  return <hr role="presentation" className="my-1 border-border" />;
}
