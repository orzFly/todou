import { createLink, useRouterState } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  type AnchorHTMLAttributes,
  type ReactNode,
  Suspense,
  useLayoutEffect,
  useRef,
} from "react";
import { PagePending } from "@/components/page-skeleton.tsx";
import { cn } from "@/lib/utils";

/**
 * Categories on the left, the chosen one on the right (T-557). Below the
 * container's `@3xl` the categories fold into one scrolling row above the
 * page instead.
 *
 * Every category is its own route, so the nav is links all the way down; the
 * Suspense here is what keeps the nav standing while a cold category loads,
 * where the shell's own boundary would have replaced it with the skeleton.
 */
export function SettingsLayout({
  label,
  nav,
  children,
}: {
  label: string;
  nav: ReactNode;
  children: ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // On the row the current category may sit past the right edge, and a row
  // whose lit item is out of sight says the reader is nowhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lit item moves with the path, which the effect reads through the DOM.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    // Half an item's worth of the neighbour stays in view, which is what
    // tells a reader the row scrolls at all.
    const peek = 48;
    const left = current.offsetLeft - nav.offsetLeft - peek;
    const right = current.offsetLeft - nav.offsetLeft + current.offsetWidth;
    if (left < nav.scrollLeft) nav.scrollLeft = left;
    else if (right + peek > nav.scrollLeft + nav.clientWidth) {
      nav.scrollLeft = right + peek - nav.clientWidth;
    }
  }, [pathname]);

  return (
    <div className="@container">
      <div className="flex flex-col gap-6 @3xl:flex-row @3xl:gap-8">
        <nav
          ref={navRef}
          aria-label={label}
          className={cn(
            "-mx-4 flex shrink-0 gap-1 overflow-x-auto border-b px-4 pb-2 whitespace-nowrap",
            "@3xl:mx-0 @3xl:w-52 @3xl:flex-col @3xl:gap-4 @3xl:self-start @3xl:overflow-visible @3xl:border-b-0 @3xl:px-0 @3xl:pb-0",
          )}
        >
          {nav}
        </nav>
        <div className="min-w-0 flex-1">
          <Suspense fallback={<PagePending />}>{children}</Suspense>
        </div>
      </div>
    </div>
  );
}

/**
 * A run of categories under one heading. On the row the heading drops out and
 * a rule between runs is what is left of it.
 */
export function SettingsNavGroup({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 not-first:border-l not-first:pl-2 @3xl:flex-col @3xl:items-stretch @3xl:gap-0.5 @3xl:not-first:border-l-0 @3xl:not-first:pl-0">
      {label && (
        <div className="hidden px-2 pb-1 text-xs font-medium text-muted-foreground @3xl:block">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

function NavAnchor({
  icon: Icon,
  className,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  icon: LucideIcon;
  ref?: React.Ref<HTMLAnchorElement>;
}) {
  return (
    <a
      {...props}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        "aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground",
        className,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {children}
    </a>
  );
}

/** One category. Takes the router's link props, plus the icon it wears. */
export const SettingsNavLink = createLink(NavAnchor);
