import { cn } from "@orz/ui";
import { AvatarFallback } from "@orz/ui/components/avatar";
import type { ProjectIconFallback } from "@todou/shared";
import { projectTint } from "@/lib/project-tint.ts";

/**
 * Every generator either kind of subject can be set to. The user enum is a
 * subset of the project one for now, so the project enum names them all.
 */
export type FallbackGenerator = ProjectIconFallback;

/**
 * What an avatar box draws when nothing was uploaded (T-544, T-555): `text`
 * drawn by `generator`, as the box's own `AvatarFallback`. Goes inside an
 * `Avatar` in place of one.
 *
 * Fitting the letters into whatever box they land in, centring them, and
 * keeping them off the copy path's line breaks are `AvatarFallback`'s
 * (UI-276); what is todou's is the colour. Monochrome draws nothing of its
 * own: the theme's muted square or circle under its muted text, the scheme
 * from before T-544. Colorful lays the slug's gradient over that square and
 * sets the letters white.
 *
 * Announced as the text, the way the bare text it replaced was; a caller
 * that sets a name beside the avatar hides the avatar instead (T-817).
 */
export function FallbackGlyph({
  text,
  generator,
  seed,
  className,
}: {
  text: string;
  generator: FallbackGenerator;
  seed: string;
  className?: string;
}) {
  const tint = generator === "colorful_text" ? projectTint(seed) : null;
  return (
    <AvatarFallback
      role="img"
      aria-label={text}
      data-generator={generator}
      className={cn(
        tint === null
          ? "font-medium"
          : // A shadow under the letters rather than a darker gradient: the
            // tint is the project's colour and stays as hashed.
            "font-semibold text-white [text-shadow:0_1px_1px_rgb(0_0_0/0.25)]",
        className,
      )}
      style={
        tint === null
          ? undefined
          : {
              backgroundImage: `linear-gradient(to bottom right, ${tint.from}, ${tint.to})`,
            }
      }
    >
      {text}
    </AvatarFallback>
  );
}
