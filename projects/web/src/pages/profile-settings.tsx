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
  ProjectIconFallback,
  RefPlacement,
  UserAvatarFallback,
} from "@todou/shared";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  prefsQuery,
  useBoxedRefLinks,
  useOpenExternalLinksInNewTab,
  usePatchPrefs,
  useProjectIconFallback,
  useRefPlacement,
  useShowRepeatedRefTitle,
  useTruncateRefTitle,
  useUserAvatarFallback,
} from "@/api/prefs.ts";
import { api, meQuery } from "@/api/queries.ts";
import { AvatarEditor } from "@/components/shared/avatar-editor.tsx";
import {
  type FallbackGenerator,
  FallbackGlyph,
} from "@/components/shared/fallback-glyph.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { UserAvatar } from "@/components/shared/user-chip.tsx";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
    </div>
  );
}

/** How issues, references and icons are drawn for this account (T-557). */
export function AppearanceSettingsPage() {
  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-xl font-semibold">Appearance</h1>
      <DisplaySection />
      <BodyReferencesSection />
      <FallbackAvatarsSection />
    </div>
  );
}

export function InboxSettingsPage() {
  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-xl font-semibold">Inbox</h1>
      <UnreadIndicatorsSection />
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
  const newTab = useOpenExternalLinksInNewTab();

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
      <ToggleRow
        id="open-external-links-in-new-tab"
        label="Open external links in a new tab"
        checked={newTab}
        disabled={pending}
        onChange={(checked) =>
          patch.mutate({ open_external_links_in_new_tab: checked })
        }
      />
    </div>
  );
}

/**
 * One option's own generator, whatever the setting currently is — which is
 * why this is not `ProjectIcon` or `UserAvatar`: those draw with the stored
 * choice.
 */
function GeneratorSample({
  generator,
  shape,
  text,
  seed,
}: {
  generator: FallbackGenerator;
  shape: "square" | "circle";
  text: string;
  seed: string;
}) {
  return (
    <Avatar
      aria-hidden="true"
      data-generator-sample={generator}
      shape={shape}
      className="inline-flex size-5 overflow-hidden align-middle"
    >
      <AvatarFallback>
        <FallbackGlyph text={text} generator={generator} seed={seed} />
      </AvatarFallback>
    </Avatar>
  );
}

function projectSample(generator: ProjectIconFallback) {
  return (
    <GeneratorSample
      generator={generator}
      shape="square"
      text="DES"
      seed="design"
    />
  );
}

function userSample(generator: UserAvatarFallback) {
  return (
    <GeneratorSample
      generator={generator}
      shape="circle"
      text="AL"
      seed="Alice Liddell"
    />
  );
}

const PROJECT_ICON_FALLBACKS: ReadonlyArray<{
  value: ProjectIconFallback;
  label: string;
  sample: ReactNode;
}> = [
  {
    value: "monochrome_text",
    label: "Monochrome text",
    sample: projectSample("monochrome_text"),
  },
  {
    value: "colorful_text",
    label: "Colorful text",
    sample: projectSample("colorful_text"),
  },
];

const USER_AVATAR_FALLBACKS: ReadonlyArray<{
  value: UserAvatarFallback;
  label: string;
  sample: ReactNode;
}> = [
  {
    value: "monochrome_text",
    label: "Monochrome text",
    sample: userSample("monochrome_text"),
  },
];

const PREVIEW_PROJECTS = [
  { slug: "design", name: "Design", prefix: "DES" },
  { slug: "api", name: "API", prefix: "API" },
  { slug: "growth", name: "Growth", prefix: "GRW" },
];

const PREVIEW_PEOPLE = [
  { login: "alice", display_name: "Alice Liddell" },
  { login: "bot-one", display_name: "bot-one" },
  { login: "newcomer", display_name: "Wei Wang" },
];

/**
 * Samples drawn by the same components as every other surface, so they follow
 * the cached prefs the moment a select changes them (T-558). Hidden from
 * assistive tech: they repeat the select's value in pictures.
 */
function FallbackPreview({ children }: { children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      data-fallback-preview=""
      className="flex gap-2 pt-1"
    >
      {children}
    </div>
  );
}

/** What a project or a person without an uploaded image is drawn as (T-555). */
function FallbackAvatarsSection() {
  const prefs = useQuery(prefsQuery);
  const patch = usePatchPrefs();
  const pending = prefs.isPending;
  const project = useProjectIconFallback();
  const user = useUserAvatarFallback();

  return (
    <div className="space-y-4 border-t pt-6">
      <div className="space-y-1">
        <h2 className="font-medium">Icons without an image</h2>
      </div>
      <PlacementRow
        id="project-icon-fallback"
        label="Projects"
        value={project}
        options={PROJECT_ICON_FALLBACKS}
        disabled={pending}
        onChange={(value) => patch.mutate({ project_icon_fallback: value })}
        preview={
          <FallbackPreview>
            {PREVIEW_PROJECTS.map((sample) => (
              <ProjectIcon
                key={sample.slug}
                project={sample}
                className="size-8"
              />
            ))}
          </FallbackPreview>
        }
      />
      <PlacementRow
        id="user-avatar-fallback"
        label="People"
        value={user}
        options={USER_AVATAR_FALLBACKS}
        disabled={pending}
        onChange={(value) => patch.mutate({ user_avatar_fallback: value })}
        preview={
          <FallbackPreview>
            {PREVIEW_PEOPLE.map((sample) => (
              <UserAvatar key={sample.login} user={sample} className="size-8" />
            ))}
          </FallbackPreview>
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
  preview,
}: {
  id: string;
  label: string;
  description?: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string; sample?: ReactNode }>;
  disabled: boolean;
  onChange: (value: V) => void;
  preview?: ReactNode;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
        {preview}
      </div>
      <Select
        value={value}
        disabled={disabled}
        // Radix hands back a bare string; the options above are the only
        // values it can hand back.
        onValueChange={(next) => onChange(next as V)}
      >
        <SelectTrigger id={id} className="shrink-0">
          {/* Radix mirrors the chosen item's text into the trigger, sample
              and all; the preview beside the label already draws it. */}
          <SelectValue>
            {selected?.sample ? selected.label : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              // Typeahead matches this; the sample's own text would
              // otherwise lead it, so "M" stopped finding Monochrome.
              textValue={option.label}
            >
              {option.sample}
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
