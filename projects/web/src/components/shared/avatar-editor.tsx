import { Trash2Icon, UploadIcon } from "lucide-react";
import { useRef } from "react";
import { initialsOf } from "@/components/shared/user-chip.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

/**
 * Avatar preview with upload/remove controls. Mutations stay with the
 * caller — this component only picks the file.
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

  return (
    <div className="flex items-center gap-4">
      <Avatar size="lg" className="size-16">
        {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
        <AvatarFallback className="text-lg">
          {initialsOf(user.display_name)}
        </AvatarFallback>
      </Avatar>
      <div className="flex gap-2">
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            // Same file re-picked after a failure must fire change again.
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon className="size-3.5" /> Upload
        </Button>
        {user.avatar_url && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onRemove}
          >
            <Trash2Icon className="size-3.5" /> Remove
          </Button>
        )}
      </div>
    </div>
  );
}
