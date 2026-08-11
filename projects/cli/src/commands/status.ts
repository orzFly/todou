import type { TodouClient } from "@todou/shared";
import { Command } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { table } from "../format.ts";

export class StatusListCommand extends ProjectCommand {
  static paths = [["status", "list"]];
  static usage = Command.Usage({ description: "List the project's statuses" });

  protected async run(client: TodouClient): Promise<void> {
    const statuses = await client.listStatuses(this.requireProject());
    this.output(statuses, () =>
      table(
        statuses
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((s) => [s.name, s.category, s.color]),
      ),
    );
  }
}
