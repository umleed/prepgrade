"use client";

import {
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/*
 * Accessible tabs following the WAI-ARIA authoring pattern: the tablist uses
 * roving tabindex, Arrow/Home/End move activation, and each panel is labelled
 * by its tab. Works controlled (`value`/`onValueChange`) and uncontrolled
 * (`defaultValue`).
 */

export type TabDefinition = {
  value: string;
  label: ReactNode;
  /** Panel content rendered below the tab list. */
  content: ReactNode;
  disabled?: boolean;
};

export type TabsProps = HTMLAttributes<HTMLDivElement> & {
  tabs: TabDefinition[];
  /** Controlled selected value. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Initial value for uncontrolled usage. Defaults to the first tab. */
  defaultValue?: string;
};

export function Tabs({
  tabs,
  value,
  onValueChange,
  defaultValue,
  className,
  ...rest
}: TabsProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [uncontrolled, setUncontrolled] = useState(
    defaultValue ?? tabs[0]?.value ?? "",
  );
  const activeValue = value ?? uncontrolled;

  const select = (next: string) => {
    if (value === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };

  const enabledValues = tabs
    .filter((tab) => !tab.disabled)
    .map((tab) => tab.value);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    if (enabledValues.length === 0) return;
    event.preventDefault();

    const current = enabledValues.indexOf(activeValue);
    let nextIndex: number;
    if (event.key === "ArrowLeft") {
      nextIndex = current <= 0 ? enabledValues.length - 1 : current - 1;
    } else if (event.key === "ArrowRight") {
      nextIndex = current === enabledValues.length - 1 ? 0 : current + 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else {
      nextIndex = enabledValues.length - 1;
    }

    const next = enabledValues[nextIndex];
    if (next === undefined) return;
    select(next);
    // Move DOM focus to the newly active tab button.
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tab-value="${next}"]`)
      ?.focus();
  };

  return (
    <div className={cn("flex flex-col gap-4", className)} {...rest}>
      <div
        ref={listRef}
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        className="-mb-px flex gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((tab) => {
          const selected = tab.value === activeValue;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              data-tab-value={tab.value}
              id={`${baseId}-tab-${tab.value}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.value}`}
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => select(tab.value)}
              className={cn(
                "shrink-0 rounded-t-field border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                "disabled:cursor-not-allowed disabled:text-ink-subtle",
                selected
                  ? "border-brand text-brand-700"
                  : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.value}
          role="tabpanel"
          id={`${baseId}-panel-${tab.value}`}
          aria-labelledby={`${baseId}-tab-${tab.value}`}
          hidden={tab.value !== activeValue}
          tabIndex={0}
          className="rounded-b-field outline-offset-2"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
