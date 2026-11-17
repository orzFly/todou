import type { Completion } from "@codemirror/autocomplete";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UserAvatar } from "@/components/shared/user-chip.tsx";
import type { PickerUser } from "@/components/shared/user-picker.tsx";

/**
 * Completion rows that name a person draw that person the way every user
 * picker does (T-677): avatar, `@login`, display name. The login leads here,
 * unlike in the pickers, because it is what is being typed and inserted.
 *
 * A WeakMap rather than a field on the completion: CodeMirror owns the
 * `Completion` shape, and a source only has to say whose row this is.
 */
const people = new WeakMap<Completion, PickerUser>();

export function withUser<C extends Completion>(
  completion: C,
  user: PickerUser,
): C {
  people.set(completion, user);
  return completion;
}

export function userOf(completion: Completion): PickerUser | undefined {
  return people.get(completion);
}

/** Tags a person's row so the theme can trade its type icon for the avatar. */
export function userOptionClass(completion: Completion): string {
  return people.has(completion) ? "cm-completion-user" : "";
}

/**
 * An `addToOptions` entry drawn by React. CodeMirror gives no hook for a row
 * leaving the DOM, so each root is unmounted on a later render once its host
 * is gone; the newest batch is spared until it has had a chance to be
 * attached.
 */
export function reactOption(
  position: number,
  className: string,
  draw: (completion: Completion) => ReactNode | null,
) {
  const mounted: { host: HTMLElement; root: Root; settled: boolean }[] = [];
  return {
    position,
    render(completion: Completion): Node | null {
      for (let i = mounted.length - 1; i >= 0; i--) {
        const entry = mounted[i];
        if (entry === undefined || !entry.settled || entry.host.isConnected)
          continue;
        entry.root.unmount();
        mounted.splice(i, 1);
      }
      const node = draw(completion);
      if (node === null) return null;
      const host = document.createElement("span");
      host.className = className;
      const root = createRoot(host);
      root.render(node);
      const entry = { host, root, settled: false };
      mounted.push(entry);
      queueMicrotask(() => {
        entry.settled = true;
      });
      return host;
    },
  };
}

/**
 * The avatar, as an `addToOptions` entry at the icon's position.
 *
 * Rendered by React because the avatar's fallback is the reader's own
 * preference (T-555), read through the query cache, and a hand-built copy
 * would drift from it.
 */
export function userAvatarOption(queryClient: QueryClient) {
  return reactOption(20, "cm-completionAvatar", (completion) => {
    const user = people.get(completion);
    if (user === undefined) return null;
    return (
      <QueryClientProvider client={queryClient}>
        <UserAvatar user={user} badge aria-hidden />
      </QueryClientProvider>
    );
  });
}
