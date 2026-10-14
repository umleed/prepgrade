/**
 * PrepGrade shared UI entry point.
 *
 * Foundational, presentational primitives built on the design tokens defined in
 * app/globals.css. Import shared components from this barrel (e.g.
 * `import { Button, Card } from "@/components/ui"`) so the surface stays stable
 * as the library grows.
 *
 * Server-safe modules (Button, Card, Input, Select, Checkbox, Badge, Alert,
 * Table, Breadcrumbs, Pagination, Skeleton, EmptyState, Tooltip) render without
 * client JavaScript. Dialog, ConfirmDialog, Tabs, and Dropdown are client
 * components because they manage focus and interactive state.
 */
export { Button, buttonClasses } from "./button";
export type {
  ButtonProps,
  ButtonVariant,
  ButtonSize,
} from "./button";

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card";

export { Input, Textarea, Label, FieldMessage, controlClasses } from "./input";
export type { InputProps, TextareaProps } from "./input";

export { Select } from "./select";
export type { SelectProps } from "./select";

export { Checkbox, Radio } from "./checkbox";

export { Badge } from "./badge";
export type { BadgeProps, BadgeTone, BadgeVariant } from "./badge";

export { Alert } from "./alert";
export type { AlertProps, AlertVariant } from "./alert";

export {
  Table,
  TableCaption,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./table";
export type { TableProps, TableHeadProps, TableCellProps } from "./table";

export { Tabs } from "./tabs";
export type { TabsProps, TabDefinition } from "./tabs";

export { Breadcrumbs } from "./breadcrumb";
export type { BreadcrumbsProps, BreadcrumbItem } from "./breadcrumb";

export { Pagination, getPageItems } from "./pagination";
export type { PaginationProps, PageItem } from "./pagination";

export { Skeleton, SkeletonText, SkeletonTable } from "./skeleton";
export type {
  SkeletonProps,
  SkeletonTextProps,
  SkeletonTableProps,
} from "./skeleton";

export { EmptyState } from "./empty-state";
export type { EmptyStateProps } from "./empty-state";

export { Dialog } from "./dialog";
export type { DialogProps, DialogSize } from "./dialog";

export { ConfirmDialog } from "./confirm-dialog";
export type { ConfirmDialogProps } from "./confirm-dialog";

export { Dropdown, DropdownItem, DropdownSeparator } from "./dropdown";
export type { DropdownProps, DropdownItemProps } from "./dropdown";

export { Tooltip } from "./tooltip";
export type { TooltipProps, TooltipSide } from "./tooltip";
