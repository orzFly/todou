import type { UserRef } from "@todou/shared";
import { UserChip } from "@/components/shared/user-chip.tsx";

const users: Record<"human" | "machine", UserRef> = {
  human: {
    id: 9001,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  machine: {
    id: 9002,
    login: "bot-one",
    display_name: "Bot One",
    kind: "machine",
    avatar_url: null,
    owner: { id: 9001, login: "alice" },
  },
};

const avatars = {
  none: null,
  success: "/test/browser/avatar-ok.svg",
  failure: "/test/browser/avatar-missing.svg",
  delayed: "/test/browser/avatar-delayed.svg?baseline=1",
} as const;

const cases = (["human", "machine"] as const).flatMap((kind) =>
  (["none", "success", "failure", "delayed"] as const).map((state) => ({
    key: `${kind}-${state}`,
    user: { ...users[kind], avatar_url: avatars[state] },
  })),
);

// Mount inside the fixture's existing RouterProvider. The smoke runner holds
// the delayed URL and returns the missing URL as a real 404 before measuring.
function markAuthor(row: HTMLParagraphElement | null) {
  const author = row?.querySelector<HTMLAnchorElement>('a[href^="/users/"]');
  if (author) author.dataset.avatarParticipant = "author";
}

export function AvatarBaselineSamples() {
  return (
    <div className="max-w-72 space-y-3">
      {cases.map(({ key, user }) => (
        <p
          key={key}
          ref={markAuthor}
          data-avatar-case={key}
          className="text-sm leading-6"
        >
          Today, <UserChip user={user} />{" "}
          <span data-avatar-participant="peer">said hello.</span>
        </p>
      ))}
    </div>
  );
}
