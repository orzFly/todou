import { useNavigate, useRouterState } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Where `/` must not steal the keystroke: the user is already typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * The project's search box, in the header on every project page (T-141).
 *
 * A form, not a button with a handler: Enter submits it the way every search
 * box on the web does, and the browser's own autofill and history come with
 * that for free. The destination is a page, so submitting navigates there
 * rather than searching in place — which is also what makes a result URL
 * shareable.
 */
export function SearchBox({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const navigate = useNavigate();
  // Seeded from the URL so landing on /search with ?q= shows the query back,
  // and reseeded whenever it changes underneath (a shared link, the back
  // button) — but left alone while the user types.
  const urlQuery = useRouterState({
    select: (s) =>
      s.location.pathname.endsWith("/search")
        ? ((s.location.search as { q?: string }).q ?? "")
        : "",
  });
  const [value, setValue] = useState(urlQuery);
  const lastSeen = useRef(urlQuery);
  if (lastSeen.current !== urlQuery) {
    lastSeen.current = urlQuery;
    setValue(urlQuery);
  }

  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <search className={cn("relative", className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const q = value.trim();
          if (q === "") return;
          navigate({
            to: "/projects/$slug/search",
            params: { slug },
            search: { q },
          });
        }}
      >
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={input}
          type="search"
          name="q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Search this project"
          placeholder="Search…"
          className="pl-7"
        />
      </form>
    </search>
  );
}
