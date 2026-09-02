import type { CommandClass } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { ApiPassthroughCommand } from "./api.ts";
import {
  AttachCommand,
  AttachDownloadCommand,
  AttachListCommand,
} from "./attach.ts";
import {
  CommentAddCommand,
  CommentDeleteCommand,
  CommentEditCommand,
  CommentListCommand,
  CommentViewCommand,
} from "./comment.ts";
import { ConfigShowCommand } from "./config.ts";
import {
  IssueCloseCommand,
  IssueCreateCommand,
  IssueDeleteCommand,
  IssueEditCommand,
  IssueEventsCommand,
  IssueListCommand,
  IssueRestoreCommand,
  IssueStatusCommand,
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
  ProjectMembersCommand,
  ProjectUnlinkCommand,
} from "./project.ts";
import {
  QuestionAnswerCommand,
  QuestionListCommand,
  QuestionWaitCommand,
} from "./question.ts";
import { SearchCommand } from "./search.ts";
import {
  SpecCommentsCommand,
  SpecListCommand,
  SpecPullCommand,
  SpecPushCommand,
  SpecResolveCommand,
  SpecReviewCommand,
  SpecStatusCommand,
  SpecWaitCommand,
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
  ConfigShowCommand,
  ProjectListCommand,
  ProjectMembersCommand,
  ProjectEditCommand,
  ProjectLinkCommand,
  ProjectUnlinkCommand,
  IssueListCommand,
  IssueCreateCommand,
  IssueViewCommand,
  IssueEventsCommand,
  IssueWatchCommand,
  IssueEditCommand,
  IssueStatusCommand,
  IssueCloseCommand,
  IssueDeleteCommand,
  IssueRestoreCommand,
  SearchCommand,
  CommentAddCommand,
  CommentListCommand,
  CommentViewCommand,
  CommentEditCommand,
  CommentDeleteCommand,
  QuestionListCommand,
  QuestionWaitCommand,
  QuestionAnswerCommand,
  SpecPushCommand,
  SpecPullCommand,
  SpecListCommand,
  SpecStatusCommand,
  SpecWaitCommand,
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
  AttachListCommand,
  AttachDownloadCommand,
  ApiPassthroughCommand,
];
