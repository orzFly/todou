import { Button } from "@orz/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@orz/ui/components/dialog";
import { EmptyState } from "@orz/ui/components/empty-state";
import { FieldDescription, FieldError } from "@orz/ui/components/field";
import { Input } from "@orz/ui/components/input";
import { Label } from "@orz/ui/components/label";
import { Textarea } from "@orz/ui/components/textarea";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { formatRef, TodouError } from "@todou/shared";
import { FolderIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { inboxQuery, unreadCounts } from "@/api/inbox.ts";
import { api, projectsQuery, watchersQuery } from "@/api/queries.ts";
import { useProjectOrder } from "@/api/useProjectOrder.ts";
import {
  ProjectCard,
  ProjectCardGrid,
} from "@/components/shared/project-card.tsx";
import { ProjectWatchersButton } from "@/components/shared/project-watchers.tsx";
import { UnreadBadge } from "@/components/unread-badge.tsx";
import { useProjectRefs } from "@/lib/use-project-refs.ts";

export function ProjectsPage() {
  const projects = useSuspenseQuery(projectsQuery);
  const inbox = useQuery(inboxQuery);
  const watchers = useQuery(watchersQuery);
  const counts = unreadCounts(inbox.data);
  // Same frecency order as the navbar switcher (T-76).
  const ordered = useProjectOrder(projects.data);
  const refs = useProjectRefs(projects.data);
  const empty = projects.data.length === 0;

  // One button opens it: in the title row, or as the empty state's action
  // when there is nothing else on the page.
  const create = (
    <DialogTrigger asChild>
      <Button size="sm">
        <PlusIcon /> New project
      </Button>
    </DialogTrigger>
  );

  return (
    <CreateProjectDialog>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="font-heading text-title font-semibold">Projects</h1>
          {!empty && create}
        </div>
        {empty ? (
          <EmptyState icon={FolderIcon} title="No projects yet" action={create}>
            Plant your first potato 🥔
          </EmptyState>
        ) : (
          <ProjectCardGrid>
            {ordered.map(({ project, neverVisited }) => {
              const count = counts[project.slug] ?? 0;
              const watching = watchers.data?.projects[project.slug];
              return (
                <ProjectCard
                  key={project.id}
                  project={{
                    slug: project.slug,
                    name: project.name,
                    prefix: refs.get(project.slug)?.prefix ?? null,
                    icon_url: project.icon_url,
                  }}
                  muted={neverVisited}
                  corner={
                    watching?.length ? (
                      <ProjectWatchersButton
                        projectName={project.name}
                        watchers={watching}
                        live
                      />
                    ) : undefined
                  }
                  action={
                    count > 0 ? (
                      <>
                        <UnreadBadge count={count} />
                        <span className="sr-only">{count} unread</span>
                      </>
                    ) : undefined
                  }
                >
                  {project.slug}
                  {project.description ? ` — ${project.description}` : ""}
                </ProjectCard>
              );
            })}
          </ProjectCardGrid>
        )}
      </div>
    </CreateProjectDialog>
  );
}

const FIELDS = ["name", "slug", "description", "ref_prefix"] as const;
type Field = (typeof FIELDS)[number];
type Errors = { fields: Partial<Record<Field, string>>; form?: string };

const isField = (value: unknown): value is Field =>
  FIELDS.includes(value as Field);

/**
 * Where each refusal is said: a taken slug under Slug, a field the server's
 * schema rejected under that field, anything else under the form.
 */
function createErrors(error: Error): Errors {
  if (!(error instanceof TodouError))
    return { fields: {}, form: error.message };
  if (error.code === "conflict") return { fields: { slug: error.message } };
  if (error.code !== "validation_failed" || !Array.isArray(error.details)) {
    return { fields: {}, form: error.message };
  }
  const fields: Errors["fields"] = {};
  const rest: string[] = [];
  for (const issue of error.details as {
    path?: unknown[];
    message?: string;
  }[]) {
    const field = issue.path?.[0];
    const message = issue.message ?? error.message;
    if (isField(field)) fields[field] ??= message;
    else rest.push(message);
  }
  if (Object.keys(fields).length === 0) return { fields, form: error.message };
  return rest.length > 0 ? { fields, form: rest.join(" ") } : { fields };
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

function CreateProjectDialog({ children }: { children: ReactNode }) {
  // The switcher footer lands here as /projects?new=1 → open on arrival,
  // and drop the param on close so reload/back don't reopen it.
  const openedViaSearch = useSearch({ from: "/authed/projects" }).new === true;
  const [open, setOpen] = useState(openedViaSearch);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [refPrefix, setRefPrefix] = useState("");
  const [errors, setErrors] = useState<Errors>({ fields: {} });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const controls = useRef<Partial<Record<Field, HTMLElement | null>>>({});

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && openedViaSearch) {
      navigate({ to: "/projects", search: {}, replace: true });
    }
  };

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        slug,
        name,
        description,
        ref_prefix: refPrefix.trim() || undefined,
      }),
    onMutate: () => setErrors({ fields: {} }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      navigate({ to: "/projects/$slug", params: { slug: project.slug } });
    },
    onError: (error) => {
      const next = createErrors(error);
      setErrors(next);
      const first = FIELDS.find((field) => next.fields[field] !== undefined);
      if (first) controls.current[first]?.focus();
    },
  });

  /** An edit answers that field's refusal, so the refusal goes. */
  const edited = (field: Field) =>
    setErrors((prev) => {
      if (prev.fields[field] === undefined) return prev;
      const { [field]: _answered, ...fields } = prev.fields;
      return { ...prev, fields };
    });

  /** The control's half of a field: its ref, its error state and what describes it. */
  const field = (name: Field, rule?: string) => {
    const error = errors.fields[name];
    const ids = [
      rule,
      error === undefined ? undefined : `project-${name}-error`,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      ref: (el: HTMLElement | null) => {
        controls.current[name] = el;
      },
      "aria-invalid": error === undefined ? undefined : true,
      "aria-describedby": ids === "" ? undefined : ids,
    };
  };
  const fieldError = (name: Field) =>
    errors.fields[name] === undefined ? null : (
      <FieldError id={`project-${name}-error`}>
        {errors.fields[name]}
      </FieldError>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                edited("name");
                if (slug === "" || slug === slugify(name)) {
                  setSlug(slugify(e.target.value));
                  edited("slug");
                }
              }}
              placeholder="My potato field"
              required
              {...field("name")}
            />
            {fieldError("name")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-slug">Slug</Label>
            <Input
              id="project-slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                edited("slug");
              }}
              pattern="[a-z0-9][a-z0-9-]*"
              placeholder="my-potato-field"
              required
              {...field("slug", "project-slug-rule")}
            />
            <FieldDescription id="project-slug-rule">
              Lowercase letters, digits and dashes.
            </FieldDescription>
            {fieldError("slug")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                edited("description");
              }}
              placeholder="Optional"
              {...field("description")}
            />
            {fieldError("description")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-ref-prefix">Issue reference format</Label>
            <div className="flex items-center gap-2">
              <Input
                id="project-ref-prefix"
                value={refPrefix}
                onChange={(e) => {
                  setRefPrefix(e.target.value.toUpperCase().trim());
                  edited("ref_prefix");
                }}
                pattern="[A-Z][A-Z0-9_]{0,19}"
                placeholder="#"
                aria-label="reference format prefix"
                className="w-32"
                {...field("ref_prefix", "project-ref-prefix-rule")}
              />
              <span
                className="text-ui text-muted-foreground"
                data-testid="ref-format-preview"
              >
                {formatRef(refPrefix.trim() || null, 1)}
              </span>
            </div>
            <FieldDescription id="project-ref-prefix-rule">
              Capital letters, digits and _, up to 20; empty uses #. Changeable
              later in Settings.
            </FieldDescription>
            {fieldError("ref_prefix")}
          </div>
          {errors.form !== undefined && <FieldError>{errors.form}</FieldError>}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
