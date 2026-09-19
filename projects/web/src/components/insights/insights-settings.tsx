import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  enumValue,
  type PutSettings,
  Role,
  type Settings,
  TodouError,
} from "@todou/shared";
import { useId, useState } from "react";
import {
  insightsSettingsQuery,
  invalidateInsights,
  updateInsightsSettingsMutation,
} from "@/api/insights.ts";
import { useCan } from "@/api/queries.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { Button } from "@/components/ui/button";

const ROLE_LABELS: Record<Role, string> = {
  remaining: "Remaining",
  completed: "Completed",
  excluded: "Excluded",
};

/** Presets edit this form's draft only; they are not another saved chart config. */
export function insightsRolePreset(
  entries: Settings["roles"],
  preset: "default" | "category",
): Settings["roles"] {
  return entries.map((entry) => {
    const role = enumValue(entry.role, "insights role");
    const category = enumValue(entry.category, "status category");
    // A preset cannot interpret a future role; only a choice on this row can
    // replace it. The request preserves the original string for untouched rows.
    if (!Role.safeParse(role).success) return entry;
    if (preset === "default") {
      if (entry.name === "Invalid") return { ...entry, role: "excluded" };
      if (entry.name === "Shipped" || entry.name === "Done")
        return { ...entry, role: "completed" };
    }
    if (category === "closed") return { ...entry, role: "completed" };
    if (category === "open") return { ...entry, role: "remaining" };
    return entry;
  });
}

export function InsightsSettings({ slug }: { slug: string }) {
  const query = useSuspenseQuery(insightsSettingsQuery(slug));
  return <SettingsEditor key={slug} slug={slug} settings={query.data} />;
}

function SettingsEditor({
  slug,
  settings,
}: {
  slug: string;
  settings: Settings;
}) {
  const canWrite = useCan(slug, "status.manage");
  const queryClient = useQueryClient();
  const id = useId();
  // Capture the full baseline on the first edit. Background refetches (including
  // the mutation's 409 invalidation) must not replace choices or their version.
  const [draft, setDraft] = useState<Settings | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const current = draft ?? settings;
  const source = enumValue(settings.source, "insights settings source");
  const definitionsChanged =
    draft !== null &&
    (draft.roles.length !== settings.roles.length ||
      draft.roles.some(
        (entry) =>
          !settings.roles.some((saved) => saved.status_id === entry.status_id),
      ));
  const dirty =
    draft !== null &&
    (draft.version !== settings.version ||
      draft.roles.length !== settings.roles.length ||
      draft.roles.some(
        (entry) =>
          settings.roles.find((saved) => saved.status_id === entry.status_id)
            ?.role !== entry.role,
      ));
  const mutationOptions = updateInsightsSettingsMutation(queryClient, slug);
  const mutation = useMutation({
    ...mutationOptions,
    onSuccess: async (saved) => {
      queryClient.setQueryData(insightsSettingsQuery(slug).queryKey, saved);
      setDraft(null);
      setConflict(false);
      setError(null);
      await invalidateInsights(queryClient, slug);
    },
    onError: async (failure) => {
      if (failure instanceof TodouError && failure.status === 409) {
        setConflict(true);
        setError(null);
        await invalidateInsights(queryClient, slug);
      } else {
        setError(failure.message);
      }
    },
  });
  const busy = mutation.isPending || reloading;

  function choose(statusId: number, role: Role) {
    if (!canWrite || busy) return;
    setDraft({
      ...current,
      roles: current.roles.map((entry) =>
        entry.status_id === statusId ? { ...entry, role } : entry,
      ),
    });
    setError(null);
  }

  function applyPreset(preset: "default" | "category") {
    if (!canWrite || busy) return;
    setDraft({ ...current, roles: insightsRolePreset(current.roles, preset) });
    setError(null);
  }

  async function reload() {
    if (busy) return;
    setReloading(true);
    setError(null);
    try {
      await queryClient.fetchQuery({
        ...insightsSettingsQuery(slug),
        staleTime: 0,
      });
      setDraft(null);
      setConflict(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not reload settings.",
      );
    } finally {
      setReloading(false);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        Insights
      </h2>
      <p className="text-sm text-muted-foreground">
        Choose how each status counts in burn charts. Remaining is unfinished
        work; Completed counts as finished work; Excluded is outside chart
        scope.
      </p>
      <p id={`${id}-consequences`} className="text-sm text-muted-foreground">
        Saving reinterprets the entire chart history using these roles. It does
        not change issue statuses, open/closed categories, or dependency
        blocking. All-closed counts still use status categories, not these
        roles.
      </p>
      <p className="text-xs text-muted-foreground">
        {source === "default"
          ? "Using default roles."
          : source === "saved"
            ? "Using saved roles."
            : `Unknown settings source: ${source}`}
      </p>
      {!canWrite && (
        <p className="text-sm text-muted-foreground">
          You can view these settings, but do not have permission to change
          them.
        </p>
      )}
      <form
        className="space-y-3"
        aria-describedby={`${id}-consequences`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canWrite || busy || !dirty || conflict || definitionsChanged)
            return;
          const input: PutSettings = {
            version: current.version,
            roles: current.roles.map(({ status_id, role }) => ({
              status_id,
              role,
            })),
          };
          mutation.mutate(input);
        }}
      >
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Presets:</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => applyPreset("default")}
            >
              Default roles
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => applyPreset("category")}
            >
              By open/closed category
            </Button>
            <span className="text-xs text-muted-foreground">
              Presets are not saved until you choose Save.
              {current.roles.some(
                (entry) => !Role.safeParse(entry.role).success,
              ) && " Unknown roles are kept until you choose a replacement."}
            </span>
          </div>
        )}
        <div className="space-y-2">
          {current.roles.map((entry) => (
            <fieldset
              key={entry.status_id}
              disabled={!canWrite || busy}
              className="space-y-2 rounded-md border px-3 py-2"
            >
              <legend className="px-1">
                <StatusPill status={entry} />
                <span className="ml-2 text-xs text-muted-foreground">
                  {entry.category}
                </span>
              </legend>
              <div className="flex flex-wrap gap-4">
                {!Role.safeParse(enumValue(entry.role, "insights role"))
                  .success && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`${id}-${entry.status_id}`}
                      value={entry.role}
                      checked
                      disabled
                    />
                    Unknown role: {entry.role}
                  </label>
                )}
                {Role.options.map((role) => (
                  <label key={role} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`${id}-${entry.status_id}`}
                      value={role}
                      checked={entry.role === role}
                      onChange={() => choose(entry.status_id, role)}
                    />
                    {ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        {(conflict || definitionsChanged) && (
          <div role="alert" className="space-y-2 text-sm">
            <p>
              Settings or statuses changed while you were editing. Your choices
              have been kept. Reload the latest settings before saving again;
              reloading discards your unsaved choices.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={reload}
            >
              {reloading ? "Reloading…" : "Reload settings"}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {canWrite && (
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              disabled={!dirty || busy || conflict || definitionsChanged}
            >
              {mutation.isPending ? "Saving…" : "Save insights settings"}
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {dirty ? "Unsaved changes" : "No unsaved changes"}
            </span>
          </div>
        )}
      </form>
    </section>
  );
}
