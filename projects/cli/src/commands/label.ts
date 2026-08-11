import type {
  LabelCreateInput,
  LabelUpdateInput,
  TodouClient,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";
import { table } from "../format.ts";
import { resolveLabel } from "../resolve.ts";

export class LabelListCommand extends ProjectCommand {
  static paths = [["label", "list"]];
  static usage = Command.Usage({ description: "List the project's labels" });

  protected async run(client: TodouClient): Promise<void> {
    const labels = await client.listLabels(this.requireProject());
    this.output(labels, () => table(labels.map((l) => [l.name, l.color])));
  }
}

export class LabelCreateCommand extends ProjectCommand {
  static paths = [["label", "create"]];
  static usage = Command.Usage({ description: "Create a label" });

  name = Option.String("--name", { required: true });
  color = Option.String("--color", {
    description: "#rrggbb (API default otherwise)",
  });

  protected async run(client: TodouClient): Promise<void> {
    // LabelCreateInput is the parsed shape where the color default is already
    // applied; the wire accepts the pre-parse shape with color omitted.
    const label = await client.createLabel(this.requireProject(), {
      name: this.name,
      ...(this.color !== undefined ? { color: this.color } : {}),
    } as LabelCreateInput);
    this.output(label, () => `created label ${label.name} (${label.color})`);
  }
}

export class LabelEditCommand extends ProjectCommand {
  static paths = [["label", "edit"]];
  static usage = Command.Usage({ description: "Rename or recolor a label" });

  labelName = Option.String({ required: true });
  name = Option.String("--name");
  color = Option.String("--color");

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const input: LabelUpdateInput = {};
    if (this.name !== undefined) input.name = this.name;
    if (this.color !== undefined) input.color = this.color;
    if (Object.keys(input).length === 0) {
      throw new CliError("nothing to change", "pass --name and/or --color");
    }
    const target = await resolveLabel(client, project, this.labelName);
    const label = await client.updateLabel(project, target.id, input);
    this.output(label, () => `updated label ${label.name} (${label.color})`);
  }
}

export class LabelDeleteCommand extends ProjectCommand {
  static paths = [["label", "delete"]];
  static usage = Command.Usage({ description: "Delete a label" });

  labelName = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const target = await resolveLabel(client, project, this.labelName);
    await client.deleteLabel(project, target.id);
    this.note(`deleted label ${target.name}`);
  }
}
