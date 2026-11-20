/**
 * Every server call site that lets a `guest` through (T-788) — a gate on a
 * capability marked `guest: "own"`, or an address read that decides
 * visibility afterwards — keyed `file#function`, with the cases in
 * guest-visibility.test.ts that prove another member's cards stay invisible
 * through it. guest-coverage.guard.test.ts fails on a call site missing
 * here, and guest-visibility.test.ts on a case name that does not exist.
 */
export const GUEST_COVERED: Record<string, string[]> = {
  "routes/issue-watch.ts#unwatchIssueRoute": [
    "marking read, muting and watching",
  ],
  "routes/issue-watch.ts#watchIssueRoute": [
    "marking read, muting and watching",
  ],
  "routes/projects.ts#getIconRoute": ["what the project shell still shows"],
  "routes/projects.ts#getRoute": ["what the project shell still shows"],
  "routes/sse.ts#projectEventsRoute": [
    "the project stream carries only the guest's cards",
  ],
  "routes/watchers.ts#projectRoute": ["the project's watchers"],
  "services/attachments.ts#completeDirectUpload": ["writes to the card"],
  "services/attachments.ts#deleteAttachment": ["writes to the card"],
  "services/attachments.ts#listAttachmentReferences": ["an attachment by id"],
  "services/attachments.ts#listDeletedAttachments": [
    "reads of the card and everything hanging off it",
  ],
  "services/attachments.ts#listIssueAttachments": [
    "reads of the card and everything hanging off it",
  ],
  "services/attachments.ts#openAttachment": ["an attachment by id"],
  "services/attachments.ts#requestDirectUpload": ["writes to the card"],
  "services/attachments.ts#uploadAttachment": ["writes to the card"],
  "services/comments.ts#createComment": [
    "writes to the card",
    "a reference the guest writes stays plain text",
  ],
  "services/comments.ts#getComment": ["a comment, by its card or by id alone"],
  "services/comments.ts#loadCommentForWrite": ["writes to the card"],
  "services/comments.ts#locateComment": [
    "a comment, by its card or by id alone",
  ],
  "services/inbox.ts#getInbox": ["the inbox, scoped or not"],
  "services/issue-references.ts#getIssueReferences": [
    "reads of the card and everything hanging off it",
    "the references panel",
  ],
  "services/issues.ts#countIssuesByCategory": ["the counts"],
  "services/issues.ts#createIssue": [
    "opening a card refers to nothing it cannot see",
  ],
  "services/issues.ts#getIssue": [
    "reads of the card and everything hanging off it",
    "block edges and timeline lines naming them",
  ],
  "services/issues.ts#listIssues": ["the issue list and its filters"],
  "services/issues.ts#setTrashed": ["writes to the card"],
  "services/issues.ts#updateIssue": ["writes to the card"],
  "services/labels.ts#listLabels": ["what the project shell still shows"],
  "services/me-events.ts#notifyIssueRead": [
    "marking read, muting and watching",
  ],
  "services/metadata.ts#listIssueMetadataNamespaces": [
    "reads of the card and everything hanging off it",
  ],
  "services/metadata.ts#readIssueMetadata": [
    "reads of the card and everything hanging off it",
  ],
  "services/mutes.ts#clearIssueMute": ["marking read, muting and watching"],
  "services/mutes.ts#clearProjectMute": ["mutes, and marking everything read"],
  "services/mutes.ts#setIssueMute": ["marking read, muting and watching"],
  "services/mutes.ts#setProjectMute": ["mutes, and marking everything read"],
  "services/questions.ts#listIssueQuestions": [
    "reads of the card and everything hanging off it",
  ],
  "services/questions.ts#withdrawQuestions": ["writes to the card"],
  "services/reads.ts#bulkMarkRead": ["mutes, and marking everything read"],
  "services/reads.ts#markIssueRead": ["marking read, muting and watching"],
  "services/reads.ts#markIssuesRead": ["marking read, muting and watching"],
  "services/reference-config.ts#getReferenceConfig": [
    "what the project shell still shows",
  ],
  "services/revisions.ts#listCommentRevisions": [
    "a comment, by its card or by id alone",
  ],
  "services/revisions.ts#listIssueRevisions": [
    "reads of the card and everything hanging off it",
  ],
  "services/spec.ts#getSpecFiles": [
    "reads of the card and everything hanging off it",
  ],
  "services/spec.ts#getSpecInfo": [
    "reads of the card and everything hanging off it",
  ],
  "services/spec.ts#listSpecComments": [
    "reads of the card and everything hanging off it",
  ],
  "services/statuses.ts#listStatuses": ["what the project shell still shows"],
  "services/timeline.ts#getCrossActivity": [
    "project and cross-project activity",
  ],
  "services/timeline.ts#getProjectActivity": [
    "project and cross-project activity",
  ],
  "services/timeline.ts#getTimeline": [
    "reads of the card and everything hanging off it",
    "block edges and timeline lines naming them",
  ],
};
