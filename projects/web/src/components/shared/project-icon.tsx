import { initialsOf } from "@/components/shared/user-chip.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * A project's icon — `UserAvatar`'s opposite number, square where people are
 * round so the two never read as the same kind of thing.
 *
 * The fallback is the REF rather than initials because most projects will
 * never upload an icon, which makes the fallback the everyday case: a bare
 * `CH` identifies a project far better than `H` does. Initials are the last
 * resort, for a project holding no usable prefix.
 */
/**
 * As much of a REF as a box this size can hold. Prefixes run to 20 characters
 * and the box is 14–40px, so the whole of a long one is never legible here —
 * and unclipped it draws straight across the card.
 */
const GLYPH_LIMIT = 3;

/**
 * What an avatar box draws for a project that has no icon.
 *
 * Exported because the settings page's icon editor draws the same box through
 * `AvatarEditor` instead of through `ProjectIcon`, and for as long as each of
 * them spelled this rule out separately the two drifted apart.
 */
export function projectIconFallback(project: {
  name: string;
  prefix?: string | null;
}): string {
  return project.prefix
    ? project.prefix.slice(0, GLYPH_LIMIT)
    : initialsOf(project.name);
}

export function ProjectIcon({
  project,
  className,
  ...props
}: {
  project: {
    name: string;
    prefix?: string | null;
    icon_url?: string | null;
  };
} & React.ComponentProps<typeof Avatar>) {
  return (
    <Avatar
      shape="square"
      // Clipped here rather than on `Avatar` itself: only this caller puts
      // text of arbitrary length in the fallback, and a shared component
      // should not carry one caller's constraint.
      className={cn(
        "inline-flex size-5 overflow-hidden align-middle",
        className,
      )}
      {...props}
    >
      {/* Absent rather than empty: an <AvatarImage> with no src would cost a
          404 on every project that has no icon, which is most of them. */}
      {project.icon_url && <AvatarImage src={project.icon_url} alt="" />}
      <AvatarFallback className="text-[10px] font-medium">
        {projectIconFallback(project)}
      </AvatarFallback>
    </Avatar>
  );
}
