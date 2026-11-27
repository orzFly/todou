import { Button } from "@orz/ui/components/button";
import {
  NavList,
  NavListHeading,
  NavListItem,
  NavListLink,
} from "@orz/ui/components/nav-list";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@orz/ui/components/sheet";
import { useMediaQuery } from "@orz/ui/hooks/use-media-query";
import { isPlainClick } from "@orz/ui/lib/link";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, Suspense, useState } from "react";
import { PagePending } from "@/components/page-skeleton.tsx";
import {
  groupCategories,
  type SettingsCategory,
} from "@/components/settings-categories.ts";
import { MD_UP } from "@/lib/breakpoints.ts";
import { type NavCurrent, useNavCurrent } from "@/lib/nav-current.ts";

/**
 * Categories on the left, the chosen one on the right (T-557). Below `md`
 * they move into a sheet, opened from a button naming the current one.
 * Exactly one of the two is mounted, so there is one nav to find.
 *
 * Every category is its own route, so the nav is links all the way down; the
 * Suspense here is what keeps the nav standing while a cold category loads,
 * where the shell's own boundary would have replaced it with the skeleton.
 */
export function SettingsLayout({
  label,
  categories,
  children,
}: {
  label: string;
  categories: readonly SettingsCategory[];
  children: ReactNode;
}) {
  const wide = useMediaQuery(MD_UP);
  const current = useNavCurrent();
  const marks = categories.map((category) => current(category));

  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-8">
      {wide ? (
        <nav aria-label={label} className="w-52 shrink-0 self-start">
          <CategoryLists categories={categories} marks={marks} />
        </nav>
      ) : (
        <CategorySheet label={label} categories={categories} marks={marks} />
      )}
      <div className="min-w-0 flex-1">
        <Suspense fallback={<PagePending />}>{children}</Suspense>
      </div>
    </div>
  );
}

function CategorySheet({
  label,
  categories,
  marks,
}: {
  label: string;
  categories: readonly SettingsCategory[];
  marks: readonly NavCurrent[];
}) {
  const [open, setOpen] = useState(false);
  const here = categories.find((_, i) => marks[i] !== false);
  const Icon = here?.icon;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" className="self-start">
          {Icon && <Icon />}
          {here?.label ?? label}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
        </SheetHeader>
        <nav aria-label={label} className="px-2 pb-4">
          <CategoryLists
            categories={categories}
            marks={marks}
            // A modified click opens a tab behind the sheet; the reader is
            // still choosing here, so it stays.
            onLinkClick={(event) => {
              if (isPlainClick(event)) setOpen(false);
            }}
          />
        </nav>
      </SheetContent>
    </Sheet>
  );
}

function CategoryLists({
  categories,
  marks,
  onLinkClick,
}: {
  categories: readonly SettingsCategory[];
  marks: readonly NavCurrent[];
  onLinkClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  let index = 0;
  return groupCategories(categories).map((run) => (
    <div key={run.items[0]?.to} className="not-first:mt-4">
      {run.group && <NavListHeading>{run.group}</NavListHeading>}
      <NavList>
        {run.items.map((category) => {
          const mark = marks[index++] ?? false;
          const Icon = category.icon;
          return (
            <NavListItem key={category.to}>
              <NavListLink asChild current={mark || undefined}>
                <Link
                  to={category.to}
                  params={category.params}
                  activeOptions={{ exact: true, includeSearch: false }}
                  onClick={onLinkClick}
                >
                  <Icon />
                  {category.label}
                </Link>
              </NavListLink>
            </NavListItem>
          );
        })}
      </NavList>
    </div>
  ));
}
