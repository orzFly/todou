import type { ReactNode } from "react";

/**
 * One header row for every section of the issue sidebar (T-403): the title,
 * and an optional control pinned to the right of it.
 *
 * The sections without a control use it too. Sharing it only where there is a
 * button would leave two header implementations behind, and a later edit to
 * one of them is exactly the drift this replaced — the controls were four
 * different shapes when they lived under their sections' content.
 *
 * `title` takes a node because Latest spec's version, Attachments' count and
 * the links those two titles became are part of the title itself.
 */
export function SidebarSection({
  name,
  title,
  action,
  testId,
  children,
}: {
  /** The `data-sidebar-section` value the order test reads. */
  name: string;
  title: ReactNode;
  action?: ReactNode;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className="space-y-2"
      data-sidebar-section={name}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
