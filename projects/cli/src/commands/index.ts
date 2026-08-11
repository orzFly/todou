import type { CommandClass } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { ApiPassthroughCommand } from "./api.ts";
import { AttachCommand } from "./attach.ts";
import { CommentAddCommand } from "./comment.ts";
import {
  IssueCloseCommand,
  IssueCreateCommand,
  IssueEditCommand,
  IssueListCommand,
  IssueViewCommand,
} from "./issue.ts";
import {
  LabelCreateCommand,
  LabelDeleteCommand,
  LabelEditCommand,
  LabelListCommand,
} from "./label.ts";
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
  IssueCreateCommand,
  IssueViewCommand,
  IssueEditCommand,
  IssueCloseCommand,
  CommentAddCommand,
  LabelListCommand,
  LabelCreateCommand,
  LabelEditCommand,
  LabelDeleteCommand,
  StatusListCommand,
  AttachCommand,
  ApiPassthroughCommand,
];
