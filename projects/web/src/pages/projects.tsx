import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, projectsQuery } from "@/api/queries.ts";
import { useProjectOrder } from "@/api/useProjectOrder.ts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function ProjectsPage() {
  const projects = useSuspenseQuery(projectsQuery);
  // Same frecency order as the navbar switcher (T-76).
  const ordered = useProjectOrder(projects.data);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <CreateProjectDialog />
      </div>
      {projects.data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          还没有项目——种下第一颗土豆吧 🥔
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ordered.map(({ project, neverVisited }) => (
            <Link
              key={project.id}
              to="/projects/$slug"
              params={{ slug: project.slug }}
            >
              <Card className="h-full transition-colors hover:bg-accent/50">
                <CardHeader>
                  <CardTitle
                    className={
                      neverVisited
                        ? "text-base text-muted-foreground"
                        : "text-base"
                    }
                  >
                    {project.name}
                  </CardTitle>
                  <CardDescription>
                    {project.slug}
                    {project.description ? ` — ${project.description}` : ""}
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateProjectDialog() {
  // The switcher footer lands here as /projects?new=1 → open on arrival,
  // and drop the param on close so reload/back don't reopen it.
  const openedViaSearch = useSearch({ from: "/authed/projects" }).new === true;
  const [open, setOpen] = useState(openedViaSearch);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && openedViaSearch) {
      navigate({ to: "/projects", search: {}, replace: true });
    }
  };

  const create = useMutation({
    mutationFn: () => api.createProject({ slug, name, description }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      navigate({ to: "/projects/$slug", params: { slug: project.slug } });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> New project
        </Button>
      </DialogTrigger>
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
                if (
                  slug === "" ||
                  slug ===
                    name
                      .toLowerCase()
                      .replaceAll(/[^a-z0-9]+/g, "-")
                      .replaceAll(/^-|-$/g, "")
                ) {
                  setSlug(
                    e.target.value
                      .toLowerCase()
                      .replaceAll(/[^a-z0-9]+/g, "-")
                      .replaceAll(/^-|-$/g, ""),
                  );
                }
              }}
              placeholder="My potato field"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-slug">Slug</Label>
            <Input
              id="project-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              pattern="[a-z0-9][a-z0-9-]*"
              placeholder="my-potato-field"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
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
