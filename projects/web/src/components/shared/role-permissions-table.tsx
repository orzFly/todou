import {
  type CapabilityId,
  can,
  capabilityOf,
  MEMBER_ROLES,
  type MemberRole,
  minRoleOf,
  ROLE_RANK,
} from "@todou/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type DisplayRow = {
  group: string;
  label: string;
  caps: readonly CapabilityId[];
};

/**
 * The catalog is cut by gate, which is the wrong grain to read: nobody wants
 * a row for `issue.count`. These rows regroup it for humans and carry no
 * role of their own — every cell is computed from the capabilities named
 * here, so a gate that moves moves this table with it.
 *
 * A test asserts each capability appears in exactly one row, which is the
 * whole guarantee that the table is not quietly missing a permission.
 */
export const DISPLAY_ROWS: readonly DisplayRow[] = [
  {
    group: "Read",
    label: "Browse the project, its issues and their timelines",
    caps: [
      "project.read",
      "project.stream",
      "issue.list",
      "issue.count",
      "issue.read",
      "issue.mark_read",
      "timeline.read",
      "activity.read",
      "inbox.read",
    ],
  },
  {
    group: "Read",
    label: "Read comments, questions and edit history",
    caps: ["comment.read", "question.read", "revision.read"],
  },
  {
    group: "Read",
    label: "Download attachments and read specs",
    caps: ["attachment.read", "spec.read"],
  },
  {
    group: "Read",
    label: "Search, and see labels, statuses, reference rules and members",
    caps: [
      "search.run",
      "label.list",
      "status.list",
      "reference.read",
      "member.list",
    ],
  },

  { group: "Report", label: "Open a new issue", caps: ["issue.create"] },
  { group: "Report", label: "Post a comment", caps: ["comment.create"] },
  {
    group: "Report",
    label: "Upload an attachment",
    caps: ["attachment.upload"],
  },
  {
    group: "Report",
    label: "Edit the title and body of an issue",
    caps: ["issue.update"],
  },
  {
    group: "Report",
    label: "Edit or delete a comment",
    caps: ["comment.modify"],
  },
  {
    group: "Report",
    label: "Move an issue to the trash",
    caps: ["issue.trash"],
  },

  {
    group: "Collaborate",
    label: "Change status, assignees and labels",
    caps: ["issue.triage"],
  },
  {
    group: "Collaborate",
    label: "Apply field commands from a comment",
    caps: ["comment.commands"],
  },
  {
    group: "Collaborate",
    label: "Answer questions",
    caps: ["question.answer"],
  },
  {
    group: "Collaborate",
    label: "Push, review and resolve specs",
    caps: ["spec.push", "spec.review", "spec.resolve"],
  },
  {
    group: "Collaborate",
    label: "Move an issue to another project",
    caps: ["issue.move", "issue.move_in"],
  },
  {
    group: "Collaborate",
    label: "Create, recolor and delete labels",
    caps: ["label.create", "label.update", "label.delete"],
  },

  {
    group: "Administer",
    label: "Rename or delete the project",
    caps: ["project.update", "project.delete"],
  },
  {
    group: "Administer",
    label: "Add and remove members, and change their role",
    caps: ["member.set", "member.remove"],
  },
  { group: "Administer", label: "Manage statuses", caps: ["status.manage"] },
  {
    group: "Administer",
    label: "Manage reference rules",
    caps: ["reference.manage"],
  },
];

/** Columns run the way the ladder does, so each one adds to the last. */
const COLUMNS: readonly MemberRole[] = [...MEMBER_ROLES].reverse();

const ownerOnly = (row: DisplayRow): boolean =>
  row.caps.some((cap) => capabilityOf(cap).ownerOnly === true);

/** A row is granted only where every capability behind it is. */
const grants = (role: MemberRole, row: DisplayRow): boolean =>
  row.caps.every((cap) => can(role, cap));

/** The strictest gate the row covers — what the row effectively costs. */
const rowMinRole = (row: DisplayRow): MemberRole =>
  row.caps.reduce<MemberRole>((highest, cap) => {
    const min = minRoleOf(cap);
    return ROLE_RANK[min] > ROLE_RANK[highest] ? min : highest;
  }, "reader");

export function RolePermissionsTable() {
  let lastGroup: string | null = null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Can</TableHead>
          {COLUMNS.map((role) => (
            <TableHead key={role} className="w-24 text-center capitalize">
              {role}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {DISPLAY_ROWS.map((row) => {
          const heading = row.group === lastGroup ? null : row.group;
          lastGroup = row.group;
          return (
            <TableRow key={row.label} data-min-role={rowMinRole(row)}>
              <TableCell>
                {heading !== null && (
                  <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {heading}
                  </div>
                )}
                <span>{row.label}</span>
                {ownerOnly(row) && (
                  <span className="text-muted-foreground"> *</span>
                )}
              </TableCell>
              {COLUMNS.map((role) => (
                <TableCell
                  key={role}
                  className="text-center"
                  aria-label={`${row.label} · ${role}`}
                >
                  {grants(role, row) ? "✓" : "—"}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function RolePermissionsDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="link"
          // Font-size and padding are the header's, not the button's: this
          // sits inside a table head and must not make the row taller.
          className="h-auto p-0 text-xs font-normal"
        >
          What can each role do?
        </Button>
      </DialogTrigger>
      {/* The `sm:` variant, because DialogContent's own default is
          `sm:max-w-sm` and a plain `max-w-*` never outranks it. */}
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>What each role can do</DialogTitle>
          <DialogDescription>
            Roles are cumulative — each one can do everything to its left. Rows
            marked * only apply to what you posted yourself; a project admin may
            act on anyone's.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <RolePermissionsTable />
        </div>
      </DialogContent>
    </Dialog>
  );
}
