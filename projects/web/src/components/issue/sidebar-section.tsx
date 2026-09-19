import type { ReactNode, Ref } from "react";

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
  focusRef,
  children,
}: {
  /** The `data-sidebar-section` value the order test reads. */
  name: string;
  title: ReactNode;
  action?: ReactNode;
  testId?: string;
  /**
   * Takes focus coming back from an overlay whose opener has unmounted while
   * it was up, which is the section's last resort once nothing inside it
   * survives (T-430). The `tabIndex` and the ring ride along rather than being
   * props of their own: without the first `.focus()` does nothing, without the
   * second a keyboard user is given no sign of where focus went, and the
   * sections needing none of it keep an unfocusable `<section>`.
   */
  focusRef?: Ref<HTMLElement>;
  children?: ReactNode;
}) {
  return (
    <section
      ref={focusRef}
      tabIndex={focusRef === undefined ? undefined : -1}
      className={
        focusRef === undefined
          ? "space-y-2"
          : "space-y-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      }
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
