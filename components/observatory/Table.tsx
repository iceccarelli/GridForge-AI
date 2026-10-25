// A real <table> that reads as a stack of labelled cards below md, so nothing scrolls sideways at 320 px. The ARIA roles are
// restated because `display: block` on table elements makes some screen readers drop the table semantics.
import type { ReactNode } from "react";

export function DataTable({ caption, head, children, className = "" }: { caption: ReactNode; head: string[]; children: ReactNode; className?: string }) {
  return (
    <table role="table" className={`block w-full text-left text-sm md:table ${className}`}>
      <caption className="mb-3 block text-left text-sm text-mute md:table-caption">{caption}</caption>
      <thead className="sr-only md:not-sr-only md:table-header-group">
        <tr role="row" className="md:table-row">
          {head.map((h) => (
            <th key={h} role="columnheader" scope="col" className="px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-mute">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="block md:table-row-group">{children}</tbody>
    </table>
  );
}

export function Row({ children, emphasis = false }: { children: ReactNode; emphasis?: boolean }) {
  return (
    <tr
      role="row"
      className={`mb-3 block rounded-lg border p-3 md:mb-0 md:table-row md:rounded-none md:border-0 md:border-t md:p-0 ${
        emphasis ? "border-queue/60 bg-queue/5" : "border-line bg-panel-2/40 md:bg-transparent"
      }`}
    >
      {children}
    </tr>
  );
}

const CELL =
  "flex items-baseline justify-between gap-3 py-1 before:shrink-0 before:text-xs before:text-mute before:content-[attr(data-label)] md:table-cell md:px-3 md:py-3 md:align-top md:before:hidden";

export function RowHead({ label, children }: { label: string; children: ReactNode }) {
  return (
    <th role="rowheader" scope="row" data-label={label} className={`${CELL} text-left font-medium text-ghost`}>
      <div className="min-w-0 text-right md:text-left">{children}</div>
    </th>
  );
}

export function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <td role="cell" data-label={label} className={CELL}>
      <div className="min-w-0 text-right md:text-left">{children}</div>
    </td>
  );
}
