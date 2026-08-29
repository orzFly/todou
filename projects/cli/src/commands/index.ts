import type { CommandClass } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { ApiPassthroughCommand } from "./api.ts";
import { AttachCommand } from "./attach.ts";
import { CommentAddCommand, CommentEditCommand } from "./comment.ts";
import {
  IssueCloseCommand,
  IssueCreateCommand,
  IssueDeleteCommand,
  IssueEditCommand,
  IssueListCommand,
  IssueRestoreCommand,
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
  ProjectEditCommand,
  ProjectLinkCommand,
  ProjectListCommand,
  ProjectUnlinkCommand,
} from "./project.ts";
import {
  QuestionAnswerCommand,
  QuestionListCommand,
  QuestionWaitCommand,
} from "./question.ts";
import {
  SpecCommentsCommand,
  SpecPullCommand,
  SpecPushCommand,
  SpecResolveCommand,
  SpecReviewCommand,
  SpecStatusCommand,
} from "./spec.ts";
import {
  StatusCreateCommand,
  StatusDeleteCommand,
  StatusEditCommand,
  StatusInitCommand,
  StatusListCommand,
} from "./status.ts";
import { WatchCommand } from "./watch.ts";
import { WhoamiCommand } from "./whoami.ts";

/** Every registerable command; grows as command files land. */
export const commands: Array<CommandClass<CliContext>> = [
  LoginCommand,
  WhoamiCommand,
  ProjectListCommand,
  ProjectEditCommand,
  ProjectLinkCommand,
  ProjectUnlinkCommand,
  IssueListCommand,
  IssueCreateCommand,
  IssueViewCommand,
  IssueWatchCommand,
  IssueEditCommand,
  IssueCloseCommand,
  IssueDeleteCommand,
  IssueRestoreCommand,
  CommentAddCommand,
  CommentEditCommand,
  QuestionListCommand,
  QuestionWaitCommand,
  QuestionAnswerCommand,
  SpecPushCommand,
  SpecPullCommand,
  SpecStatusCommand,
  SpecCommentsCommand,
  SpecResolveCommand,
  SpecReviewCommand,
  LabelListCommand,
  LabelCreateCommand,
  LabelEditCommand,
  LabelDeleteCommand,
  StatusListCommand,
  StatusCreateCommand,
  StatusEditCommand,
  StatusDeleteCommand,
  StatusInitCommand,
  WatchCommand,
  AttachCommand,
  ApiPassthroughCommand,
];
