import type { CommandClass } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { IssueListCommand, IssueViewCommand } from "./issue.ts";
import { LabelListCommand } from "./label.ts";
import {
  ProjectLinkCommand,
  ProjectListCommand,
  ProjectUnlinkCommand,
} from "./project.ts";
import { StatusListCommand } from "./status.ts";
import { WhoamiCommand } from "./whoami.ts";

/** Every registerable command; grows as command files land. */
export const commands: Array<CommandClass<CliContext>> = [
  WhoamiCommand,
  ProjectListCommand,
  ProjectLinkCommand,
  ProjectUnlinkCommand,
  IssueListCommand,
  IssueViewCommand,
  LabelListCommand,
  StatusListCommand,
];
