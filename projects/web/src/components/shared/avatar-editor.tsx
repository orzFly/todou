import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  isAvatarContentType,
} from "@todou/shared";
import { Trash2Icon, UploadIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { initialsOf } from "@/components/shared/user-chip.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { fitAvatar } from "@/lib/avatar-resize.ts";
import { cn } from "@/lib/utils";

const MAX_MB = AVATAR_MAX_BYTES / 1024 / 1024;

/**
 * Avatar preview with upload/remove controls. Mutations stay with the
 * caller — this component only picks the file. Picking covers three entries
 * (button, drop, paste), all of which meet in `handleFile`, so the caller's
 * `onUpload` contract is unchanged: one `File`, already within the size cap.
 */
export function AvatarEditor({
  user,
  onUpload,
  onRemove,
  pending = false,
}: {
  user: { display_name: string; avatar_url: string | null };
  onUpload: (file: File) => void;
  onRemove: () => void;
  pending?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLFieldSetElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [draggingOver, setDraggingOver] = useState(false);
  const dragDepth = useRef(0);
  const busy = pending || preparing;

  const handleFile = useCallback(
    async (file: File) => {
      if (!isAvatarContentType(file.type)) {
        toast.error("Avatar must be a PNG, JPEG, WebP, or GIF image.");
        return;
      }
      setPreparing(true);
      let result: Awaited<ReturnType<typeof fitAvatar>>;
      try {
        result = await fitAvatar(file);
      } finally {
        setPreparing(false);
      }
      if (result.kind === "undecodable") {
        toast.error("Couldn't read that image.");
        return;
      }
      if (result.kind === "too-large") {
        // The server would truncate the request anyway; saying so here spares
        // the user a multi-megabyte round trip for the same answer.
        toast.error(`Couldn't get that image under the ${MAX_MB} MB limit.`);
        return;
      }
      if (result.kind === "resized" && file.type === "image/gif") {
        toast.warning(
          "That GIF was too large to keep, so it was uploaded as a still frame — the animation is gone.",
        );
      }
      onUpload(result.file);
    },
    [onUpload],
  );

  // `paste` is only delivered to the focused element, so hovering alone can
  // never reach a handler on this container — the listener has to sit on the
  // document, and decide for itself whether the paste was aimed here.
  const armed = hovered || focused;
  useEffect(() => {
    if (!armed) return;
    const onPaste = (event: ClipboardEvent) => {
      // `focused` outlives the focus itself: preparing disables the button
      // holding it, and the focusout Chrome fires inside that commit loses its
      // reset. So the live DOM decides; the flag only decides whether to
      // listen at all. Without this, one keyboard-started upload leaves every
      // later paste on the page landing in the avatar.
      const area = zone.current;
      if (!area) return;
      if (!hovered && !area.contains(document.activeElement)) return;

      const image = Array.from(event.clipboardData?.files ?? []).find((file) =>
        file.type.startsWith("image/"),
      );
      // Wider than the accepted set on purpose: this only decides whether the
      // paste was aimed at the avatar. Claiming a text paste would break
      // typing into a field elsewhere on the page while the pointer rests here.
      if (!image) return;
      event.preventDefault();
      void handleFile(image);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [armed, hovered, handleFile]);

  return (
    <fieldset
      ref={zone}
      // The drop target is the whole row, not the 64 px circle — too small to
      // aim at. A fieldset because the row is now a named group of controls
      // rather than a layout box, and only a grouping element may carry the
      // drop and hover handlers.
      aria-label="avatar"
      className={cn(
        "flex items-center gap-4 rounded-md",
        // outline rather than border: it takes no layout space, so the button
        // row does not shift when the highlight appears.
        draggingOver &&
          "outline-2 outline-primary outline-dashed outline-offset-4",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // focusin/focusout bubble, so this reads as focus-within and the Upload /
      // Remove buttons carry the focus — no extra tab stop on the container.
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      onDragEnter={(e) => {
        dragDepth.current += 1;
        if (e.dataTransfer.types.includes("Files")) setDraggingOver(true);
      }}
      onDragLeave={() => {
        // dragleave also fires when the pointer crosses into a child, so only
        // the exit that balances the outermost enter really leaves the area.
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDraggingOver(false);
        }
      }}
      onDragOver={(e) => {
        // Without this the browser navigates to the dropped file.
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDraggingOver(false);
        // An avatar is one image; anything else in the drop is ignored.
        const file = e.dataTransfer.files[0];
        if (file) void handleFile(file);
      }}
    >
      <Avatar size="lg" className="size-16">
        {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
        <AvatarFallback className="text-lg">
          {initialsOf(user.display_name)}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <input
            ref={fileInput}
            type="file"
            accept={AVATAR_CONTENT_TYPES.join(",")}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              // Same file re-picked after a failure must fire change again.
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <UploadIcon className="size-3.5" /> Upload
          </Button>
          {user.avatar_url && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRemove}
            >
              <Trash2Icon className="size-3.5" /> Remove
            </Button>
          )}
        </div>
        {/* Drop and paste have no affordance of their own, and paste only
            works over this area — so it has to be said. */}
        <p className="text-xs text-muted-foreground">
          Drop or paste an image here.
        </p>
      </div>
    </fieldset>
  );
}
