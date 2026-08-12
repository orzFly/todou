import type { CommandClass } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { ApiPassthroughCommand } from "./api.ts";
import { AttachCommand } from "./attach.ts";
import { CommentAddCommand, CommentEditCommand } from "./comment.ts";
import {
  IssueCloseCommand,
  IssueCreateCommand,
  IssueEditCommand,
  IssueListCommand,
  IssueViewCommand,
  IssueWatchCommand,
} from "./issue.ts";
import {
  LabelCreateCommand,
  LabelDeleteCommand,
  LabelEditCommand,
  LabelListCommand,
} from "./label.ts";
import { LoginCommand } from "./login.ts";
import {
  ProjectLinkCommand,
  ProjectListCommand,
  ProjectUnlinkCommand,
} from "./project.ts";
import {
  QuestionAnswerCommand,
  QuestionListCommand,
  QuestionWaitCommand,
} from "./question.ts";
import { SpecPullCommand, SpecPushCommand, SpecStatusCommand } from "./spec.ts";
import { StatusListCommand } from "./status.ts";
import { WatchCommand } from "./watch.ts";
import { WhoamiCommand } from "./whoami.ts";

/** Every registerable command; grows as command files land. */
export const commands: Array<CommandClass<CliContext>> = [
  LoginCommand,
  WhoamiCommand,
  ProjectListCommand,
  ProjectLinkCommand,
  ProjectUnlinkCommand,
  IssueListCommand,
  IssueCreateCommand,
  IssueViewCommand,
  IssueWatchCommand,
  IssueEditCommand,
  IssueCloseCommand,
  CommentAddCommand,
  CommentEditCommand,
  QuestionListCommand,
  QuestionWaitCommand,
  QuestionAnswerCommand,
  SpecPushCommand,
  SpecPullCommand,
  SpecStatusCommand,
  LabelListCommand,
  LabelCreateCommand,
  LabelEditCommand,
  LabelDeleteCommand,
  StatusListCommand,
  WatchCommand,
  AttachCommand,
  ApiPassthroughCommand,
];
