import type {
  Status,
  StatusCategory,
  StatusCreateInput,
  StatusUpdateInput,
  TodouClient,
} from "@todou/shared";
import { TodouError } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";
import { table } from "../format.ts";
import { byName, resolveStatus } from "../resolve.ts";

/** The board order the server uses everywhere: (position, id). */
function boardOrder(statuses: Status[]): Status[] {
  return statuses
    .slice()
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

function parseCategory(raw: string): StatusCategory {
  if (raw !== "open" && raw !== "closed") {
    throw new CliError(`invalid category "${raw}"`, "use open or closed");
  }
  return raw;
}

type Shift = { status: Status; position: number };
type Placement = { position: number; shifts: Shift[] };

function anchorRef(
  before: string | undefined,
  after: string | undefined,
): string | undefined {
  if (before !== undefined && after !== undefined) {
    throw new CliError(
      "--before and --after are mutually exclusive",
      "pass only one of them",
    );
  }
  return before ?? after;
}

/**
 * Plan placing a row at `index` within `others` (board-sorted, the row
 * itself excluded). The server's create/patch never move neighbors and ties
 * sort by id, so the plan claims the slot right after the left neighbor and
 * pushes the right-hand run up one by one until an existing gap absorbs it.
 */
function planPlacement(others: Status[], index: number): Placement {
  const left = others[index - 1];
  const position = left === undefined ? 0 : left.position + 1;
  const shifts: Shift[] = [];
  let watermark = position;
  for (const status of others.slice(index)) {
    // Positions ascend in board order: the first gap clears all the rest.
    if (status.position > watermark) break;
    watermark += 1;
    shifts.push({ status, position: watermark });
  }
  return { position, shifts };
}

async function applyShifts(
  client: TodouClient,
  project: string,
  shifts: Shift[],
): Promise<void> {
  for (const shift of shifts) {
    await client.updateStatus(project, shift.status.id, {
      position: shift.position,
    });
    shift.status.position = shift.position;
  }
}

export class StatusListCommand extends ProjectCommand {
  static paths = [["status", "list"]];
  static usage = Command.Usage({ description: "List the project's statuses" });

  protected async run(client: TodouClient): Promise<void> {
    const statuses = await client.listStatuses(this.requireProject());
    this.output(statuses, () =>
      table(
        boardOrder(statuses).map((s) => [
          s.name,
          s.category,
          s.color,
          s.is_default ? "default" : "",
        ]),
      ),
    );
  }
}

export class StatusCreateCommand extends ProjectCommand {
  static paths = [["status", "create"]];
  static usage = Command.Usage({ description: "Create a status" });

  name = Option.String("--name", { required: true });
  category = Option.String("--category", {
    required: true,
    description: "open or closed",
  });
  color = Option.String("--color", {
    description: "#rrggbb (API default otherwise)",
  });
  before = Option.String("--before", {
    description: "Place it before this status",
  });
  after = Option.String("--after", {
    description: "Place it after this status",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const category = parseCategory(this.category);

    const anchorName = anchorRef(this.before, this.after);
    let placement: Placement | undefined;
    if (anchorName !== undefined) {
      const sorted = boardOrder(await client.listStatuses(project));
      const anchor = byName(sorted, anchorName, "status");
      const anchorIndex = sorted.findIndex((s) => s.id === anchor.id);
      placement = planPlacement(
        sorted,
        this.before !== undefined ? anchorIndex : anchorIndex + 1,
      );
    }

    // StatusCreateInput is the parsed shape where the color default is
    // already applied; the wire accepts the pre-parse shape with it omitted.
    const status = await client.createStatus(project, {
      name: this.name,
      category,
      ...(this.color !== undefined ? { color: this.color } : {}),
      ...(placement === undefined ? {} : { position: placement.position }),
    } as StatusCreateInput);
    if (placement !== undefined) {
      await applyShifts(client, project, placement.shifts);
      if (placement.shifts.length > 0) {
        this.note(
          `made room by moving ${placement.shifts
            .map((s) => s.status.name)
            .join(", ")}`,
        );
      }
    }
    this.output(
      status,
      () =>
        `created status ${status.name} (${status.category}, ${status.color}) at position ${status.position}`,
    );
  }
}

export class StatusEditCommand extends ProjectCommand {
  static paths = [["status", "edit"]];
  static usage = Command.Usage({
    description: "Rename, restyle, reorder, or make a status the default",
  });

  statusName = Option.String({ required: true });
  name = Option.String("--name");
  category = Option.String("--category", { description: "open or closed" });
  color = Option.String("--color");
  before = Option.String("--before", {
    description: "Move it before this status",
  });
  after = Option.String("--after", {
    description: "Move it after this status",
  });
  isDefault = Option.Boolean("--default", {
    description: "New issues land here (--no-default clears it)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const anchorName = anchorRef(this.before, this.after);

    const input: StatusUpdateInput = {};
    if (this.name !== undefined) input.name = this.name;
    if (this.category !== undefined) {
      input.category = parseCategory(this.category);
    }
    if (this.color !== undefined) input.color = this.color;
    if (this.isDefault !== undefined) input.is_default = this.isDefault;
    if (Object.keys(input).length === 0 && anchorName === undefined) {
      throw new CliError(
        "nothing to change",
        "pass --name, --category, --color, --before/--after, or --default",
      );
    }

    const sorted = boardOrder(await client.listStatuses(project));
    const target = byName(sorted, this.statusName, "status");

    let shifts: Shift[] = [];
    if (anchorName !== undefined) {
      const anchor = byName(sorted, anchorName, "status");
      if (anchor.id === target.id) {
        throw new CliError(
          `cannot move "${target.name}" relative to itself`,
          "anchor --before/--after on a different status",
        );
      }
      const others = sorted.filter((s) => s.id !== target.id);
      const anchorIndex = others.findIndex((s) => s.id === anchor.id);
      const placement = planPlacement(
        others,
        this.before !== undefined ? anchorIndex : anchorIndex + 1,
      );
      input.position = placement.position;
      shifts = placement.shifts;
    }

    const status = await client.updateStatus(project, target.id, input);
    await applyShifts(client, project, shifts);
    this.output(
      status,
      () =>
        `updated status ${status.name} (${status.category}, ${status.color})${
          status.is_default ? " — default" : ""
        }`,
    );
  }
}

export class StatusDeleteCommand extends ProjectCommand {
  static paths = [["status", "delete"]];
  static usage = Command.Usage({
    description: "Delete a status (refused while issues still use it)",
  });

  statusName = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const target = await resolveStatus(client, project, this.statusName);
    try {
      await client.deleteStatus(project, target.id);
    } catch (error) {
      if (error instanceof TodouError && error.status === 409) {
        throw new CliError(
          error.message,
          `find them with \`todou issue list --status "${target.name}"\`, then \`todou issue edit <n> --status <other>\``,
        );
      }
      throw error;
    }
    this.note(`deleted status ${target.name}`);
  }
}

/** The status set agents expect on every project (see the todou-cli skill). */
const CANONICAL_STATUSES: ReadonlyArray<
  Pick<Status, "name" | "category" | "color">
> = [
  { name: "Backlog", category: "open", color: "#6b7280" },
  { name: "Todo", category: "open", color: "#6b7280" },
  { name: "Next", category: "open", color: "#6b7280" },
  { name: "In Progress", category: "open", color: "#3b82f6" },
  { name: "Ready to Ship", category: "open", color: "#f59e0b" },
  { name: "Shipped", category: "open", color: "#8b5cf6" },
  { name: "Done", category: "closed", color: "#22c55e" },
];

export class StatusInitCommand extends ProjectCommand {
  static paths = [["status", "init"]];
  static usage = Command.Usage({
    description:
      "Create the missing canonical statuses (Backlog → … → Done), in order",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const board = boardOrder(await client.listStatuses(project));
    const created: Status[] = [];
    let previous: Status | undefined;
    for (const canonical of CANONICAL_STATUSES) {
      const existing = board.find(
        (s) => s.name.toLowerCase() === canonical.name.toLowerCase(),
      );
      if (existing !== undefined) {
        previous = existing;
        continue;
      }
      // Each missing status goes right after its canonical predecessor, so
      // pre-existing custom statuses keep their relative order.
      const prev = previous;
      const index =
        prev === undefined ? 0 : board.findIndex((s) => s.id === prev.id) + 1;
      const placement = planPlacement(board, index);
      const status = await client.createStatus(project, {
        ...canonical,
        position: placement.position,
      } as StatusCreateInput);
      await applyShifts(client, project, placement.shifts);
      board.splice(index, 0, status);
      created.push(status);
      previous = status;
    }

    // Without an explicit default, new issues fall back to the first status
    // by position (T-14) — which init just changed by putting Backlog ahead
    // of Todo. Pin Todo so the effective default stays put.
    let defaulted: Status | undefined;
    if (!board.some((s) => s.is_default)) {
      const todo = board.find((s) => s.name.toLowerCase() === "todo");
      if (todo !== undefined) {
        defaulted = await client.updateStatus(project, todo.id, {
          is_default: true,
        });
        todo.is_default = true;
      }
    }

    this.output({ created: created.map((s) => s.name), statuses: board }, () =>
      [
        created.length === 0
          ? "all canonical statuses already exist"
          : `created ${created.map((s) => s.name).join(", ")}`,
        ...(defaulted === undefined
          ? []
          : [`made ${defaulted.name} the default status`]),
      ].join("\n"),
    );
  }
}
