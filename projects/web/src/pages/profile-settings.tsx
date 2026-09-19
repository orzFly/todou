import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type {
  BoardRefPlacement,
  Me,
  MeUpdateInput,
  RefPlacement,
} from "@todou/shared";
import { useState } from "react";
import { toast } from "sonner";
import {
  prefsQuery,
  useBoxedRefLinks,
  usePatchPrefs,
  useRefPlacement,
  useShowRepeatedRefTitle,
  useTruncateRefTitle,
} from "@/api/prefs.ts";
import { api, meQuery } from "@/api/queries.ts";
import { AvatarEditor } from "@/components/shared/avatar-editor.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/** The signed-in user's own profile. Agents are edited via /settings/agents. */
export function ProfileSettingsPage() {
  const me = useSuspenseQuery(meQuery);
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(me.data.display_name);
  const [login, setLogin] = useState(me.data.login);

  // Profile fields are denormalized into every issue/timeline/member
  // payload — after a change, drop the whole cache rather than chase keys.
  const applyUpdate = (updated: Me) => {
    queryClient.setQueryData(["me"], updated);
    queryClient.invalidateQueries();
  };

  const save = useMutation({
    mutationFn: (input: MeUpdateInput) => api.updateMe(input),
    onSuccess: (updated) => {
      applyUpdate(updated);
      toast.success("Profile updated.");
    },
    onError: (error) => toast.error(error.message),
  });
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadMyAvatar(file),
    onSuccess: (updated) => {
      applyUpdate(updated);
      toast.success("Avatar updated.");
    },
    onError: (error) => toast.error(error.message),
  });
  const removeAvatar = useMutation({
    mutationFn: () => api.deleteMyAvatar(),
    onSuccess: (updated) => {
      applyUpdate(updated);
      toast.success("Avatar removed.");
    },
    onError: (error) => toast.error(error.message),
  });

  const patch: MeUpdateInput = {};
  if (displayName !== me.data.display_name) patch.display_name = displayName;
  if (login !== me.data.login) patch.login = login;
  const dirty = Object.keys(patch).length > 0;

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Profile</h1>
      </div>

      <AvatarEditor
        subject={{
          name: me.data.display_name,
          imageUrl: me.data.avatar_url,
        }}
        onUpload={(file) => upload.mutate(file)}
        onRemove={() => removeAvatar.mutate()}
        pending={upload.isPending || removeAvatar.isPending}
      />

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate(patch);
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="profile-display">Display name</Label>
          <Input
            id="profile-display"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={200}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-login">Login</Label>
          <Input
            id="profile-login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            pattern="[a-z0-9][a-z0-9-]*"
            maxLength={64}
            required
          />
          <p className="text-xs text-muted-foreground">
            Lowercase letters, digits, and dashes. Existing issues and comments
            follow a rename automatically, but anything typing the old login by
            hand (scripts, saved filters) needs updating.
          </p>
        </div>
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          Save changes
        </Button>
      </form>

      <UnreadIndicatorsSection />
      <DisplaySection />
      <BodyReferencesSection />
    </div>
  );
}

/**
 * The weak-unread toggle (T-97). Server-side preference: the same value
 * drives the hollow-ring markers here and the weak-unread filter inside
 * GET /me/inbox, so every browser agrees.
 */
function UnreadIndicatorsSection() {
  const prefs = useQuery(prefsQuery);
  const patch = usePatchPrefs();
  const showWeak = prefs.data?.show_weak_unread ?? true;

  return (
    <div className="space-y-3 border-t pt-6">
      <h2 className="font-medium">Unread indicators</h2>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="weak-unread-toggle">Weak unread hints</Label>
          <p className="text-sm text-muted-foreground">
            Show a hollow ring on issues whose only news is events — no new
            comments — and list them in the Inbox.
          </p>
        </div>
        <Switch
          id="weak-unread-toggle"
          checked={showWeak}
          disabled={prefs.isPending}
          onCheckedChange={(checked) =>
            patch.mutate({ show_weak_unread: checked })
          }
        />
      </div>
    </div>
  );
}

const FLAT_PLACEMENTS: ReadonlyArray<{ value: RefPlacement; label: string }> = [
  { value: "before", label: "Before title" },
  { value: "after", label: "After title" },
];

const BOARD_PLACEMENTS: ReadonlyArray<{
  value: BoardRefPlacement;
  label: string;
}> = [
  { value: "before", label: "Before title" },
  { value: "after", label: "After title, in the meta row" },
  { value: "own_line", label: "On its own line" },
];

/** Where the issue number sits relative to the title, per surface (T-157). */
function DisplaySection() {
  const prefs = useQuery(prefsQuery);
  const patch = usePatchPrefs();
  const pending = prefs.isPending;
  const list = useRefPlacement("list");
  const board = useRefPlacement("board");
  const detail = useRefPlacement("detail");
  const reference = useRefPlacement("reference");

  return (
    <div className="space-y-4 border-t pt-6">
      <div className="space-y-1">
        <h2 className="font-medium">Issue number placement</h2>
      </div>
      <PlacementRow
        id="ref-placement-list"
        label="Issue lists & Inbox"
        value={list}
        options={FLAT_PLACEMENTS}
        disabled={pending}
        onChange={(value) => patch.mutate({ ref_placement_list: value })}
      />
      <PlacementRow
        id="ref-placement-board"
        label="Board cards"
        description="On its own line puts the number under the title, above labels and assignees."
        value={board}
        options={BOARD_PLACEMENTS}
        disabled={pending}
        onChange={(value) => patch.mutate({ ref_placement_board: value })}
      />
      <PlacementRow
        id="ref-placement-detail"
        label="Issue page title"
        description="The floating title bar and the browser tab title follow it."
        value={detail}
        options={FLAT_PLACEMENTS}
        disabled={pending}
        onChange={(value) => patch.mutate({ ref_placement_detail: value })}
      />
      <PlacementRow
        id="ref-placement-reference"
        label="Issue references"
        value={reference}
        options={FLAT_PLACEMENTS}
        disabled={pending}
        onChange={(value) => patch.mutate({ ref_placement_reference: value })}
      />
    </div>
  );
}

/** How a rich reference is drawn inside a description or a comment (T-371). */
function BodyReferencesSection() {
  const prefs = useQuery(prefsQuery);
  const patch = usePatchPrefs();
  const pending = prefs.isPending;
  const boxed = useBoxedRefLinks();
  const truncate = useTruncateRefTitle();
  const repeated = useShowRepeatedRefTitle();

  return (
    <div className="space-y-4 border-t pt-6">
      <div className="space-y-1">
        <h2 className="font-medium">References in text</h2>
        <p className="text-sm text-muted-foreground">
          These reach references inside descriptions and comments. Timeline rows
          keep their own look whatever is set here.
        </p>
        <p className="text-sm text-muted-foreground">
          Reference slugs and issue prefixes shorten to fit their parent
          container, independently of the title setting. Copying preserves the
          full reference.
        </p>
      </div>
      <ToggleRow
        id="boxed-ref-links"
        label="Bordered references"
        checked={boxed}
        disabled={pending}
        onChange={(checked) => patch.mutate({ boxed_ref_links: checked })}
      />
      <ToggleRow
        id="truncate-ref-title"
        label="Shorten long titles"
        checked={truncate}
        disabled={pending}
        onChange={(checked) => patch.mutate({ truncate_ref_title: checked })}
      />
      <ToggleRow
        id="show-repeated-ref-title"
        label="Title on every mention"
        description="Repeated comments keep their reference and author. Comments on this card show only #comment-N and the author; ordinary issue references to this card say “current” when this is off."
        checked={repeated}
        disabled={pending}
        onChange={(checked) =>
          patch.mutate({ show_repeated_ref_title: checked })
        }
      />
    </div>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function PlacementRow<V extends string>({
  id,
  label,
  description,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  disabled: boolean;
  onChange: (value: V) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <Select
        value={value}
        disabled={disabled}
        // Radix hands back a bare string; the options above are the only
        // values it can hand back.
        onValueChange={(next) => onChange(next as V)}
      >
        <SelectTrigger id={id} className="shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
