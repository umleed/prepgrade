import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/*
 * Dense-but-readable data tables for results, question banks, and member
 * lists. The wrapper scrolls horizontally on small screens instead of
 * squashing columns; headers use the muted 2xs style and rows a subtle
 * hover tint. Numeric cells align right with tabular figures.
 */

export type TableProps = HTMLAttributes<HTMLTableElement>;

export function Table({ className, ...rest }: TableProps) {
  return (
    <div className="w-full overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table
        className={cn("w-full caption-bottom border-collapse text-sm", className)}
        {...rest}
      />
    </div>
  );
}

export function TableCaption({
  className,
  ...rest
}: HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption
      className={cn("px-4 py-3 text-left text-sm text-ink-muted", className)}
      {...rest}
    />
  );
}

export function TableHeader({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("border-b border-border bg-surface-muted", className)}
      {...rest}
    />
  );
}

export function TableBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn(className)} {...rest} />;
}

export function TableRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-border transition-colors last:border-b-0 hover:bg-canvas",
        className,
      )}
      {...rest}
    />
  );
}

export type TableHeadProps = ThHTMLAttributes<HTMLTableCellElement> & {
  /** Right-align with tabular figures (scores, counts, amounts). */
  numeric?: boolean;
};

export function TableHead({ className, numeric, ...rest }: TableHeadProps) {
  return (
    <th
      scope="col"
      className={cn(
        "h-10 px-4 text-2xs font-semibold uppercase tracking-wide text-ink-muted",
        numeric ? "text-right tabular-nums" : "text-left",
        className,
      )}
      {...rest}
    />
  );
}

export type TableCellProps = TdHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean;
  /** Render as a row header (`<th scope="row">`) instead of a plain cell. */
  asHeader?: boolean;
};

export function TableCell({
  className,
  numeric,
  asHeader,
  children,
  ...rest
}: TableCellProps) {
  const Component = asHeader ? "th" : "td";
  return (
    <Component
      scope={asHeader ? "row" : undefined}
      className={cn(
        "px-4 py-3 align-middle text-ink",
        numeric && "text-right tabular-nums",
        asHeader && "text-left font-medium",
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}
