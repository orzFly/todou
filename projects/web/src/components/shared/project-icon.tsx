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
      className={cn("inline-flex size-5 align-middle", className)}
      {...props}
    >
      {/* Absent rather than empty: an <AvatarImage> with no src would cost a
          404 on every project that has no icon, which is most of them. */}
      {project.icon_url && <AvatarImage src={project.icon_url} alt="" />}
      <AvatarFallback className="text-[10px] font-medium">
        {project.prefix || initialsOf(project.name)}
      </AvatarFallback>
    </Avatar>
  );
}
