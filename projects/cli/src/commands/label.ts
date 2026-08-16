import type { LabelUpdateInput, TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";
import { table } from "../format.ts";
import { parseColor } from "../parse.ts";
import { labelColorFor, resolveLabel, shellArg } from "../resolve.ts";

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
  static usage = Command.Usage({
    description: "Create a label",
    details:
      "The name is a positional (gh's shape) or `--name`. Rarely needed by hand: `issue create --label` and `issue edit --add-label` create what they do not find.",
    examples: [
      ["gh's shape", "todou label create 'area:cli' --color '#3b82f6'"],
      ["Let the color follow from the name", "todou label create 'area:cli'"],
    ],
  });

  positionalName = Option.String({ required: false });
  nameFlag = Option.String("--name", {
    description: "The name, when not given as a positional",
  });
  color = Option.String("--color", {
    description: "#rrggbb (derived from the name otherwise)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const name = this.resolveName();
    const color =
      this.color === undefined
        ? labelColorFor(name)
        : parseColor(this.color, "--color");
    const label = await client.createLabel(project, { name, color });
    this.output(label, () => `created label ${label.name} (${label.color})`);
    if (this.color === undefined) {
      this.note(
        `color derived from the name · recolor: todou label edit ` +
          `${shellArg(label.name)} -p ${project} --color '#rrggbb'`,
      );
    }
  }

  private resolveName(): string {
    const { positionalName, nameFlag } = this;
    if (positionalName !== undefined && nameFlag !== undefined) {
      if (positionalName !== nameFlag) {
        throw new CliError(
          `the positional says "${positionalName}" but --name says "${nameFlag}"`,
          "drop one of them — they must agree",
        );
      }
      return nameFlag;
    }
    const name = positionalName ?? nameFlag;
    if (name === undefined) {
      throw new CliError(
        "no label name",
        "todou label create <name> [--color '#rrggbb']",
      );
    }
    return name;
  }
}

export class LabelEditCommand extends ProjectCommand {
  static paths = [["label", "edit"]];
  static usage = Command.Usage({ description: "Rename or recolor a label" });

  labelName = Option.String({ required: true });
  name = Option.String("--name");
  color = Option.String("--color", { description: "#rrggbb" });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const input: LabelUpdateInput = {};
    if (this.name !== undefined) input.name = this.name;
    if (this.color !== undefined) {
      input.color = parseColor(this.color, "--color");
    }
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
  // gh prompts for confirmation and takes --yes to skip it. Nothing here
  // ever prompts, so the flag is already satisfied — accepting it keeps a
  // gh-shaped command line from failing on an option it does not need.
  yes = Option.Boolean("-y,--yes", false, {
    description: "Accepted for gh compatibility; deletes never prompt here",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const target = await resolveLabel(client, project, this.labelName);
    await client.deleteLabel(project, target.id);
    this.note(`deleted label ${target.name}`);
  }
}
