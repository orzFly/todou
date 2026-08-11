import type { TodouClient } from "@todou/shared";
import { Command } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { table } from "../format.ts";

export class LabelListCommand extends ProjectCommand {
  static paths = [["label", "list"]];
  static usage = Command.Usage({ description: "List the project's labels" });

  protected async run(client: TodouClient): Promise<void> {
    const labels = await client.listLabels(this.requireProject());
    this.output(labels, () => table(labels.map((l) => [l.name, l.color])));
  }
}
