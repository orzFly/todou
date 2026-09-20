import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  declarationErrors,
  readSources,
  type Source,
  scanSources,
} from "./enum-fallback-audit.ts";
import baseline from "./enum-fallback-baseline.json" with { type: "json" };

/**
 * Full census of TypeScript/TSX under projects/{shared,web,cli,server}/src.
 * Every switch, fixed-key Record and bound Object.fromEntries result is
 * discovered; computed lookups discover untyped and inline maps too. Calls
 * with an outer Record annotation/assertion or an explicitly Record-returning
 * function also qualify. Local aliases and named imports/re-exports resolve
 * syntactically. Names never decide whether a key is server-origin.
 *
 * DECLARED documents actual producers for shapes the scanner cannot prove.
 * Add one only after tracing the input. Removing a lookup/default-less switch,
 * or adding a recognized guard, makes its declaration stale and fails the test.
 * Duplicate expressions have an occurrence ordinal so a new bare read fails.
 *
 * Boundaries: no interprocedural taint/type inference, namespace/dynamic imports,
 * destructured aliases, generated string-code parsing, Map.get, or if/ternary
 * enum dispatch census. If/ternary branches are not semantically audited: syntax
 * alone cannot
 * distinguish a membership predicate or a locally/parse-narrowed union from an
 * unvalidated wire enum whose else arm assigns a known meaning; consumer tests
 * must exercise future values.
 * A default's semantics and a fallback's wording also need behavioral tests.
 * ??/|| proves a fallback, not prototype-key safety; own-key
 * safety for wire mappings is covered by enumLookup and its behavioral tests.
 * Provenance declarations require review if an upstream producer changes.
 * Record inside a call argument, generic container, callback, array or object
 * property does not describe the result. Assertions of incoming identifiers
 * and empty dynamic dictionaries are not new mapping definitions. Factory
 * return-type aliases and unannotated arbitrary factory bodies are not inferred.
 */
const DECLARED: Readonly<Record<string, string>> = {
  "projects/cli/src/follow-advice.ts :: read BACKGROUNDED[harness] #1":
    "Closed client producer: detectHarnessId selects a member of local HARNESSES; udsParagraphs is called only with the literal claude-code or omp.",
  "projects/cli/src/follow-advice.ts :: read HARNESS_LABELS[harness] #1":
    "Closed client producer: detectHarnessId selects a member of local HARNESSES; udsParagraphs is called only with the literal claude-code or omp.",
  "projects/cli/src/follow-advice.ts :: read HARNESS_LABELS[harness] #2":
    "Closed client producer: detectHarnessId selects a member of local HARNESSES; udsParagraphs is called only with the literal claude-code or omp.",
  "projects/cli/src/hide.ts :: read CROSSED_EFFECT[entry.reason] #1":
    "Closed client producer: applyHidePolicy calls shared selectHidable; skip/crossed reasons are constructed there from local literals, not copied from timeline payloads.",
  "projects/cli/src/hide.ts :: read SKIP_REASON_LABEL[entry.reason] #1":
    "Closed client producer: applyHidePolicy calls shared selectHidable; skip/crossed reasons are constructed there from local literals, not copied from timeline payloads.",
  "projects/cli/src/hide.ts :: read SKIP_REASON_LABEL[entry.reason] #2":
    "Closed client producer: applyHidePolicy calls shared selectHidable; skip/crossed reasons are constructed there from local literals, not copied from timeline payloads.",
  'projects/cli/src/timeline.ts :: read { approve: "approved", request_changes: "changes requested", comment: "commented", }[verdict] #1':
    "Parsed payload: SpecReviewPayload.safeParse(payload) succeeds before review.data.verdict is destructured and used by this inline table.",
  "projects/server/src/auth/oidc.ts :: read CLIENT_AUTH_IMPLS[method] #1":
    "Parsed server config: shared OidcConfig.token_endpoint_auth_method is an enum; otherwise method is selected from CLIENT_AUTH_METHODS.find(...) or its first local literal.",
  "projects/server/src/db/driver.ts :: read MIGRATIONS[tier] #1":
    "Same-version internal discriminator: migrate/openDatabase callers in index.ts and db/router.ts supply literal system or project DbTier.",
  "projects/server/src/db/driver.ts :: read MIGRATIONS[tier] #2":
    "Same-version internal discriminator: migrate/openDatabase callers in index.ts and db/router.ts supply literal system or project DbTier.",
  "projects/server/src/db/pglite-worker.ts :: switch msg.op #1":
    "Same-version worker protocol: db/worker-client.ts constructs op using seven local literals; no independent server/client version boundary. An invalid internal op would leave its promise pending.",
  "projects/server/src/http/content-type.ts :: read KEPT_TYPES[base] #1":
    "Membership predicate, not an enum label: parser-derived MIME base is compared to true and unknown media types fall through to OCTET_STREAM.",
  "projects/server/src/http/content-type.ts :: read TEXT_LIKE_APPLICATION[base] #1":
    "Membership predicate, not an enum label: parser-derived MIME base is compared to true and unknown media types fall through to OCTET_STREAM.",
  "projects/server/src/http/content-type.ts :: read VIEWABLE_TYPES[base] #1":
    "Membership predicate, not an enum label: parser-derived MIME base is compared to true and unknown media types fall through to OCTET_STREAM.",
  "projects/server/src/services/activity-calendar/evidence.ts :: read rules[kind] #1":
    "Closed server producer: ACTIVITY_EVENT_TYPES.map supplies kind from the local literal allowlist, and rules is a total Record of that list. Persisted columns.type is only the SQL CASE operand; unknown types reach ELSE false, never index rules.",
  "projects/server/src/services/agents.ts :: read ROLE_RANK[role] #1":
    "Same-version server DB role: project_members.role is written by this server from parsed MemberRole requests; listing sort trusts that internal invariant. Drizzle enum is NOT a runtime parse or DB CHECK.",
  "projects/server/src/services/attachment-names.ts :: read COMPOUND_EXTENSIONS[`${before}.${last}`.toLowerCase()] #1":
    "Membership predicate: upload filename suffix is compared with === true; unknown or inherited keys do not match and the ordinary extension path is used.",
  "projects/server/src/services/attachment-names.ts :: read COMPRESSION_SUFFIXES[last] #1":
    "Membership predicate: upload filename suffix is compared with === true; unknown or inherited keys do not match and the ordinary extension path is used.",
  "projects/server/src/services/attachment-relabel.ts :: switch subject.kind #1":
    "Same-version local Subject producer: collect/build constructs issue_body, comment, or spec_file literals before write switches on subject.kind.",
  "projects/server/src/services/cli-auth.ts :: switch target.kind #1":
    "Parsed request: routes/cli-auth.ts c.req.valid(json).target is validated by CliAuthApproveInput/CliAuthTarget discriminatedUnion via OpenAPIHono defaultHook.",
  "projects/server/src/services/commands.ts :: switch command.type #1":
    "Parsed request: routes/issues.ts validates CommandSubmitInput; command.type comes from its six-member discriminatedUnion before both execution passes.",
  "projects/server/src/services/commands.ts :: switch command.type #2":
    "Parsed request: routes/issues.ts validates CommandSubmitInput; command.type comes from its six-member discriminatedUnion before both execution passes.",
  "projects/server/src/services/insights/buckets.ts :: read FIXED_MS[grain] #1":
    "Parsed BurnQuery grain -> local resolveGrain; FIXED_MS is partial by design. Each result is compared with undefined before fixed math, otherwise calendar boundaries are used.",
  "projects/server/src/services/insights/buckets.ts :: read FIXED_MS[resolved] #1":
    "Parsed BurnQuery grain -> local resolveGrain; FIXED_MS is partial by design. Each result is compared with undefined before fixed math, otherwise calendar boundaries are used.",
  "projects/server/src/services/insights/buckets.ts :: read FIXED_MS[resolved] #2":
    "Parsed BurnQuery grain -> local resolveGrain; FIXED_MS is partial by design. Each result is compared with undefined before fixed math, otherwise calendar boundaries are used.",
  "projects/server/src/services/issues.ts :: read { created: issues.createdAt, updated: issues.updatedAt, number: issues.number, }[query.sort] #1":
    "Parsed request: IssueListQuery.sort is validated by the route before listIssues selects created/updated/number SQL columns using this inline object.",
  "projects/server/src/services/issues.ts :: read counts[row.category] #1":
    "Same-version internal statuses.category: server writes parsed open/closed categories; aggregation trusts those DB rows. Drizzle enum is compile-time only, not a runtime read check.",
  "projects/server/src/services/members.ts :: read ROLE_RANK[before] #1":
    "Same-version server role invariant: roles combine MemberSetInput parsed at routes/projects.ts with project_members rows written by this server. DB reads are not parsed; mixed-version DB writers/manual corruption are outside this exception.",
  "projects/server/src/services/members.ts :: read ROLE_RANK[ceiling] #1":
    "Same-version server role invariant: roles combine MemberSetInput parsed at routes/projects.ts with project_members rows written by this server. DB reads are not parsed; mixed-version DB writers/manual corruption are outside this exception.",
  "projects/server/src/services/members.ts :: read ROLE_RANK[ceiling] #2":
    "Same-version server role invariant: roles combine MemberSetInput parsed at routes/projects.ts with project_members rows written by this server. DB reads are not parsed; mixed-version DB writers/manual corruption are outside this exception.",
  "projects/server/src/services/members.ts :: read ROLE_RANK[effect.role] #1":
    "Same-version server role invariant: roles combine MemberSetInput parsed at routes/projects.ts with project_members rows written by this server. DB reads are not parsed; mixed-version DB writers/manual corruption are outside this exception.",
  "projects/server/src/services/members.ts :: read ROLE_RANK[effect.role] #2":
    "Same-version server role invariant: roles combine MemberSetInput parsed at routes/projects.ts with project_members rows written by this server. DB reads are not parsed; mixed-version DB writers/manual corruption are outside this exception.",
  "projects/server/src/services/members.ts :: read ROLE_RANK[effect.role] #3":
    "Same-version server role invariant: roles combine MemberSetInput parsed at routes/projects.ts with project_members rows written by this server. DB reads are not parsed; mixed-version DB writers/manual corruption are outside this exception.",
  "projects/server/src/services/members.ts :: read ROLE_RANK[machine.role] #1":
    "Same-version server role invariant: roles combine MemberSetInput parsed at routes/projects.ts with project_members rows written by this server. DB reads are not parsed; mixed-version DB writers/manual corruption are outside this exception.",
  "projects/server/src/services/members.ts :: read ROLE_RANK[role] #1":
    "Same-version server role invariant: roles combine MemberSetInput parsed at routes/projects.ts with project_members rows written by this server. DB reads are not parsed; mixed-version DB writers/manual corruption are outside this exception.",
  "projects/server/src/services/refs-migrate.ts :: switch segment.subject.kind #1":
    "Same-version local Segment producer: collection constructs issue_body/comment/spec_file subjects before applyWrite dispatches segment.subject.kind.",
  "projects/server/src/services/search.ts :: switch filter.key #1":
    "Parsed search query: parseSearchQuery resolves filter.key only after Object.hasOwn(SEARCH_QUALIFIER_KEYS, typed); server planQualifiers gets the resulting closed qualifier set.",
  "projects/server/src/services/users.ts :: read ROLE_RANK[a.role] #1":
    "Same-version server DB role: projectMembers rows are written from parsed MemberRole inputs by this server; list sorting trusts the internal invariant, not a DB CHECK.",
  "projects/server/src/services/users.ts :: read ROLE_RANK[b.role] #1":
    "Same-version server DB role: projectMembers rows are written from parsed MemberRole inputs by this server; list sorting trusts the internal invariant, not a DB CHECK.",
  "projects/shared/src/client.ts :: mapping headers #1":
    "Transport headers object: fixed accept key plus dynamic header spreads; it is passed to fetch, not used as an enum dispatch map.",
  "projects/shared/src/permissions.ts :: read ROLE_RANK[min] #1":
    "Validated local capability catalog: can obtains min from minRoleOf, which validates CAPABILITIES minimum against ROLE_RANK before this lookup.",
  "projects/shared/src/search-query.ts :: read SEARCH_IS_DOMAIN[canonical] #1":
    "Validated local value: canonicalQualifierValue(is, value) returns only SEARCH_QUALIFIERS.is accepted values or null; null is continued before indexing.",
  "projects/shared/src/search-query.ts :: read SEARCH_QUALIFIERS[key] #1":
    "Closed qualifier producer: parseSearchQuery maps typed input through Object.hasOwn(SEARCH_QUALIFIER_KEYS, typed); canonical/verdict helpers receive that registry key.",
  "projects/shared/src/search-query.ts :: read SEARCH_QUALIFIERS[key] #2":
    "Closed qualifier producer: parseSearchQuery maps typed input through Object.hasOwn(SEARCH_QUALIFIER_KEYS, typed); canonical/verdict helpers receive that registry key.",
  "projects/web/src/api/search.ts :: read SEARCH_DOMAIN_IS[d] #1":
    "Closed domain selection: caller domains originate from SEARCH_DOMAINS options or searchDomainsOf parseSearchQuery; SEARCH_DOMAIN_IS maps that local domain union.",
  "projects/web/src/api/event-rules.ts :: switch event.entity #1":
    "Parsed SSE boundary: the page onChangeFrame and worker RuntimeWatch.accept parse CrossChangeEvent before invalidationsFor; shared ChangeEntity is a closed enum, including forwarded page frames.",
  "projects/web/src/api/event-rules.ts :: switch event.entity #2":
    "Parsed SSE boundary: entityInvalidations receives invalidationsFor's event after CrossChangeEvent parsing in the page handler or worker RuntimeWatch.accept.",
  "projects/web/src/api/event-rules.ts :: switch event.kind #1":
    "Parsed SSE boundary: page onMeFrame parses MeEventSchema and worker RuntimeWatch.accept parses MeEvent before meInvalidations dispatches the closed kind union.",
  "projects/web/src/api/event-rules.ts :: switch verdict.verdict #1":
    "Closed rule producer: issueRow constructs contains/read literals; issueListInvalidation constructs fields or copies the activity/gone kind from parsed IssueListRow. coalesceBatch preserves those verdicts before the counts decision.",
  "projects/web/src/api/event-rules.ts :: switch verdict.verdict #2":
    "Closed rule producer: issueRow and issueListInvalidation construct contains/read/fields/activity/gone from local literals or parsed IssueListRow; entryWantsRefetch receives those verdicts for page membership decisions.",
  "projects/web/src/api/runtime/projections.ts :: mapping KINDS #1":
    "Membership-only recipe registry: defineProjection rejects !Object.hasOwn(KINDS, descriptor.kind); no lookup maps an unknown wire discriminator to a known recipe.",
  "projects/web/src/api/runtime/protocol.ts :: switch message.type #1":
    "Protocol validation boundary: recognized message cases return only after field validation; invalid fields break and unknown types fall through to the unconditional RuntimeError after the switch. Neither can produce a ClientMessage.",
  "projects/web/src/api/runtime/resources.ts :: read RESOURCE_POLICIES[descriptor.policyId] #1":
    "Validated resource: policyFor calls validateResource before lookup; that validator rejects policyId unless Object.hasOwn(RESOURCE_POLICIES, input.policyId), then checks the policy path and version constraints.",
  "projects/web/src/api/runtime/resources.ts :: read RESOURCE_POLICIES[input.policyId] #1":
    "Own-key validation in this function: validateResource throws on !Object.hasOwn(RESOURCE_POLICIES, input.policyId) before reading the policy path; inherited and unknown policy IDs cannot reach the lookup.",
  "projects/web/src/api/runtime/session.ts :: switch message.type #1":
    "Parsed port protocol: receive calls parseClientMessage, which rejects unknown or malformed types; HELLO returns before this switch, and remaining dispatch also checks bound port, runtime generation and account authorization.",
  "projects/web/src/components/insights/insights-settings.tsx :: read ROLE_LABELS[role] #1":
    "Closed options: Role.options.map((role) => ...) -> ROLE_LABELS[role]. Wire entry.role is only compared in checked={entry.role === role}; it is never the lookup key.",
  "projects/web/src/components/issue/metadata-dialog.tsx :: read PARSERS[t] #1":
    "Closed client tabs: local Radix triggers emit browse/bulk/json; both parser lookups exclude browse before indexing the bulk/json parser table.",
  "projects/web/src/components/issue/metadata-dialog.tsx :: read PARSERS[tab] #1":
    "Closed client tabs: local Radix triggers emit browse/bulk/json; both parser lookups exclude browse before indexing the bulk/json parser table.",
  "projects/web/src/components/page-skeleton.tsx :: switch kind #1":
    "Closed router metadata: PagePending reads route staticData.pageSkeleton authored in this client, falling back to DEFAULT_KIND; it is not a server value.",
  "projects/web/src/components/search-box.tsx :: read COMPLETION_ICON[row.row.icon] #1":
    "Closed CompletionRow.icon producer: suggestions.ts constructs only qualifier/value/project literal icons; HTTP fields supply text, not this discriminator.",
  "projects/web/src/components/search/highlight.tsx :: read SEARCH_QUALIFIERS[key] #1":
    "Closed qualifier producer: highlighted parts come from parseSearchQuery and its hasOwn-checked SEARCH_QUALIFIER_KEYS registry.",
  "projects/web/src/components/search/highlight.tsx :: read VALUE_CLASS[verdictOf(part.key, value.value, known)] #1":
    "Closed local result: verdictOf computes valid/special/invalid/unknown literals from parsed search qualifiers; the returned verdict indexes VALUE_CLASS.",
  "projects/web/src/components/search/suggestions.ts :: read KEY_HINT[key] #1":
    "Closed qualifier producer: KEYS = Object.keys(SEARCH_QUALIFIERS), or parsed search parts accepted by the hasOwn-checked qualifier registry; key selects labels/specs.",
  "projects/web/src/components/search/suggestions.ts :: read SEARCH_QUALIFIERS[key] #1":
    "Closed qualifier producer: KEYS = Object.keys(SEARCH_QUALIFIERS), or parsed search parts accepted by the hasOwn-checked qualifier registry; key selects labels/specs.",
  "projects/web/src/components/shared/agent-projects-dialog.tsx :: read ROLE_RANK[option] #1":
    "Closed UI options: option comes from MemberRole.options. Current API role and ceiling are separately checked with roleRankOf; neither is the raw map key here.",
  "projects/web/src/components/shared/return-link.tsx :: read ARROW[back.scale] #1":
    "Closed client prop: BackScale is a local union and ARROW is a total Record of it; every render site writes the scale as a literal — nav inside NavBackControl, heading at issue-detail.tsx, compact at issue-return-row.tsx and spec-view.tsx. IssueReturnLink hands its own prop through unchanged on the no-origin arrow.",
  "projects/web/src/components/shared/return-link.tsx :: read ARROW[back.scale] #2":
    "Closed client prop: BackScale is a local union and ARROW is a total Record of it; every render site writes the scale as a literal — nav inside NavBackControl, heading at issue-detail.tsx, compact at issue-return-row.tsx and spec-view.tsx. CollectionLink is reached only by spread from IssueReturnLink, carrying that same prop.",
  "projects/web/src/components/shared/return-link.tsx :: read ARROW[back.scale] #3":
    "Closed client prop: BackScale is a local union and ARROW is a total Record of it; every render site writes the scale as a literal — nav inside NavBackControl, heading at issue-detail.tsx, compact at issue-return-row.tsx and spec-view.tsx. SpecReturnLink is rendered by NavBackControl and by spec-view.tsx, each with one of those literals.",
  "projects/web/src/components/shared/return-link.tsx :: read ARROW[back.scale] #4":
    "Closed client prop: BackScale is a local union and ARROW is a total Record of it; every render site writes the scale as a literal — nav inside NavBackControl, heading at issue-detail.tsx, compact at issue-return-row.tsx and spec-view.tsx. ProjectReturnLink is rendered only by NavBackControl, with the nav literal.",
  "projects/web/src/components/shared/return-link.tsx :: read ARROW[back.scale] #5":
    "Closed client prop: BackScale is a local union and ARROW is a total Record of it; every render site writes the scale as a literal — nav inside NavBackControl, heading at issue-detail.tsx, compact at issue-return-row.tsx and spec-view.tsx. ProjectsReturnLink is rendered only by NavBackControl, with the nav literal.",
  "projects/web/src/components/shared/return-link.tsx :: read BOX[scale] #1":
    "Closed client prop, narrowed: the same literal-written BackScale, minus nav — BackButton returns the tab-strip form before this line, leaving heading and compact, which BOX declares in full.",
  "projects/web/src/components/shared/return-link.tsx :: switch kind #1":
    "Closed router metadata: shell.tsx reads staticData.backControl, which router.tsx authors as one of the four BackControlKind literals; it is not a server value, and every member returns an element.",
  "projects/web/src/components/shared/return-link.tsx :: switch view.target.kind #1":
    "Parsed history state: readReturnEntry calls parseReturnView; returnTargetSchema validates the destination discriminatedUnion before view.target.kind reaches CollectionLink.",
  "projects/web/src/components/shared/role-permissions-table.tsx :: read ROLE_RANK[highest] #1":
    "Validated local capability minimum: rowMinRole calls minRoleOf for local CAPABILITIES; highest starts at reader and is updated only from those validated minima.",
  "projects/web/src/components/shared/role-permissions-table.tsx :: read ROLE_RANK[min] #1":
    "Validated local capability minimum: rowMinRole calls minRoleOf for local CAPABILITIES; highest starts at reader and is updated only from those validated minima.",
  "projects/web/src/components/timeline/event-group.tsx :: switch family #1":
    "Closed group producer: groupTimeline obtains MergeFamily from familyOf -> enumLookup(FAMILY_BY_TYPE, type, () => null); unknown wire events cannot become a group family.",
  "projects/web/src/components/timeline/group-events.ts :: read listed[side] #1":
    "Closed client grouping state: AssigneeSide is locally assigned added/removed from recognized assigned/unassigned events; side and end.last index local sets/arrays.",
  "projects/web/src/components/timeline/group-events.ts :: read listed[side] #2":
    "Closed client grouping state: AssigneeSide is locally assigned added/removed from recognized assigned/unassigned events; side and end.last index local sets/arrays.",
  "projects/web/src/components/timeline/group-events.ts :: read net[end.last] #1":
    "Closed client grouping state: AssigneeSide is locally assigned added/removed from recognized assigned/unassigned events; side and end.last index local sets/arrays.",
  "projects/web/src/components/timeline/group-events.ts :: read touched[side] #1":
    "Closed client grouping state: AssigneeSide is locally assigned added/removed from recognized assigned/unassigned events; side and end.last index local sets/arrays.",
  "projects/web/src/components/timeline/spec-version-card.tsx :: read CHANGE_BADGE[row.change] #1":
    "Closed display rows: specVersionStatsQuery calls computeVersionStats, which constructs added/modified/removed/renamed literals from payload paths and snapshot comparisons. Before stats arrive, SpecVersionCardBody constructs added/modified/removed fallback rows from safeParsed SpecPushedPayload; neither path copies a wire change discriminator.",
  "projects/web/src/lib/editor/code-context.ts :: mapping LITERAL_NODES #1":
    "Membership-only registry: all consumers use Object.hasOwn(LITERAL_NODES/RAW_HTML_NODES, Lezer node name); absent/inherited node names return false.",
  "projects/web/src/lib/editor/code-context.ts :: mapping RAW_HTML_NODES #1":
    "Membership-only registry: all consumers use Object.hasOwn(LITERAL_NODES/RAW_HTML_NODES, Lezer node name); absent/inherited node names return false.",
  "projects/web/src/lib/harness.ts :: read HARNESS_META[agent as HarnessId] #1":
    "Matching own-key conditional: harnessMeta returns Object.hasOwn(HARNESS_META, agent) ? HARNESS_META[agent as HarnessId] : undefined. The casted key refers to the checked agent; unknown or inherited keys take the undefined branch.",
  'projects/web/src/lib/insights-search.ts :: read { "7d": 7, "30d": 30, "90d": 90 }[preset] #1':
    "Parsed URL preset: parseInsightsSearch selects a member of INSIGHTS_PRESETS; insightsPresetRequest handles 24h first, leaving only 7d/30d/90d for this table.",
  'projects/web/src/lib/rehype-decorations.ts :: read ( { paragraph: "p", table: "table", tableRow: "tr", blockquote: "blockquote", image: "img", } as Record<string, string> )[ref.type] #1':
    "Local structural block type from markdown parser; default switch branch compares an element tagName with this inline lookup. Missing map value yields no match, not rendered enum text.",
  "projects/web/src/lib/rehype-decorations.ts :: read CLASS_OF[kind] #1":
    "Closed local span kind: spec-decorations emits ins; spec-view builds annotation kind comment/draft; wrap receives only these literals.",
  "projects/web/src/lib/rehype-decorations.ts :: read TAG_OF[kind] #1":
    "Closed local span kind: spec-decorations emits ins; spec-view builds annotation kind comment/draft; wrap receives only these literals.",
  "projects/web/src/lib/remark-frontmatter-table.ts :: read SEPARATOR[child.type] #1":
    "Local mdast node discriminator; sep = SEPARATOR[child.type] is checked for undefined before frontmatterFields, otherwise the original child is preserved.",
  "projects/web/src/lib/return-view.ts :: switch target.kind #1":
    "Parsed history target: parseReturnView validates returnTargetSchema discriminatedUnion; locally constructed links also use literal kind values.",
  "projects/web/src/lib/slash-commands.ts :: read CROSSED_SUMMARY[reason] #1":
    "Closed client result: selectHidable builds SkipReason/CrossedReason from local literals; timeline entries do not supply these reason strings.",
  "projects/web/src/lib/slash-commands.ts :: read SKIP_REASON_LABEL[entry.reason] #1":
    "Closed client result: selectHidable builds SkipReason/CrossedReason from local literals; timeline entries do not supply these reason strings.",
  "projects/web/src/pages/cli-auth.tsx :: switch target.kind #1":
    "Closed local AuthTarget: useTargetSelection constructs me/agent/new kind literals; server agent rows supply ids only, new login separately passes Login.safeParse.",
  "projects/web/src/pages/inbox.tsx :: read TAB_LABELS[key] #1":
    "Closed local tabs: INBOX_TABS.find matches URL input or returns all; labels are indexed directly by INBOX_TABS.map, never by the raw search.tab.",
  "projects/web/src/pages/inbox.tsx :: switch tab #1":
    "Closed local tabs: INBOX_TABS.find matches URL input or returns all; labels are indexed directly by INBOX_TABS.map, never by the raw search.tab.",
  'projects/web/src/pages/insights.tsx :: read { "1h": 1, "6h": 6, "12h": 12 }[grain] #1':
    "Parsed BurnQuery grain/local autoGrain: earlier grain===1d/1w branches handle calendar units; the remaining grain is locally resolved 1h/6h/12h.",
  "projects/web/src/pages/insights.tsx :: read GRAIN_LABELS[grain] #1":
    "Closed options: Grain.options.map((grain) => ...) supplies this key; URL search grain is separately validated with Grain.safeParse/BurnQuery.safeParse.",
  "projects/web/src/pages/project-settings.tsx :: read ROLE_RANK[role] #1":
    "Closed UI options: role comes from ROLES = MemberRole.options and its filtered choices; API current role and owner ceiling are separately recognized with roleRankOf.",
  "projects/web/src/pages/project-settings.tsx :: read ROLE_RANK[role] #2":
    "Closed UI options: role comes from ROLES = MemberRole.options and its filtered choices; API current role and owner ceiling are separately recognized with roleRankOf.",
  "projects/cli/src/config.ts :: mapping doc #1":
    "Configuration dictionary: saveCliConfig JSON-clones CliConfig, iterates Object.values(doc.servers ?? {}) to delete empty tokens/instead_of properties, then serializes doc with stringify. No enum discriminator indexes this object.",
  "projects/server/src/services/insights-settings.ts :: mapping nextRoles #1":
    "Status-id dictionary: routes/insights validates PutSettings, then validateCompleteMapping checks every current status id. nextRoles is persisted as insightsSettings.roles; rolesOf later indexes by status id and applies storedRole's literal allowlist plus defaultInsightsRole fallback.",
  "projects/server/src/services/insights/aggregate.ts :: mapping result #1":
    "Closed server metric catalog: finishFlow maps local FLOW_KEYS literals to measured counts. Its result is spread into the Flow response, not indexed by an incoming enum discriminator.",
  "projects/shared/src/permissions.ts :: read BY_ID[id] #1":
    "Closed capability catalog: BY_ID is built from local CAPABILITIES. capabilityOf is called by role-permissions-table's ownerOnly with literal capability ids from local DISPLAY_ROWS.caps; no wire role value supplies this key.",
  "projects/shared/src/permissions.ts :: read BY_ID[id] #2":
    "Closed capability ids: minRoleOf callers use local literals, DISPLAY_ROWS.caps, or wrappers can/useCan/roleTag/requireCapability that forward those ids. members.targetOf chooses between literal capability arguments. Wire role strings are separately handled by roleRankOf and never index BY_ID.",
  "projects/web/src/lib/activity-calendar-search.ts :: mapping values #1":
    "Intl date-parts dictionary: activityToday maps formatToParts from an en-US-u-ca-gregory-nu-latn formatter with year/month/day options. It reads only fixed year, month and day properties to build the date string; no wire enum selects a label.",
  "projects/web/src/pages/agents-settings.tsx :: mapping search #1":
    "Router query dictionary: useSearch is asserted to Record<string, unknown>; the fixed search.state property selects the local deactivated/active UI segment. No computed enum lookup consumes this dictionary.",
  "projects/web/src/pages/cli-auth.tsx :: mapping search #1":
    "Router query dictionary: parseCliAuthSearch reads fixed code/port/state/name properties, validates normalized codes with CliAuthCode.safeParse, and checks loopback port/state before constructing a local target. This is not an enum dispatch mapping.",
  "projects/web/src/pages/grant-access.tsx :: mapping refs #1":
    "Project-slug dictionary: projectSpellings builds refs keyed by slug and GrantAccessCard passes it to TargetRow. The actual consumers read refs[candidate]?.prefix ?? null and refs[slug]?.prefix ?? null for ProjectIcon; missing references fall back to null.",
  "projects/web/src/pages/grant-access.tsx :: mapping routerSearch #1":
    "Router query dictionary: parseGrantSearch reads fixed target/login/uid properties, normalizes targets and login, and retains only a positive integer uid. Targets are resolved separately by resolveGrantTarget; no enum label table is indexed by routerSearch.",
  "projects/web/src/pages/inbox.tsx :: mapping search #1":
    "Router query dictionary: the fixed search.tab property is matched against local INBOX_TABS and falls back to all before tab dispatch or label selection. The search object itself is not an enum label mapping.",
  "projects/web/src/pages/login.tsx :: mapping search #1":
    "Router query dictionary: LoginPage reads fixed redirect/error/subject properties. safeRedirect accepts only same-site paths; error and subject are string-checked, and oidcErrorText has an explicit unknown-code default. The dictionary is not an enum label map.",
};

/**
 * Baseline identities remain those measured at 5db8c5c. Explicit relocations
 * preserve their guarded state and declaration checks after pure extraction;
 * new sites still need their own declarations and cannot replace a lost site.
 */
const RELOCATED_BASELINE_SITES: Readonly<Record<string, string>> = {
  "projects/web/src/api/useUserEvents.ts :: switch event.entity #1":
    "projects/web/src/api/event-rules.ts :: switch event.entity #1",
  "projects/web/src/api/useUserEvents.ts :: switch event.entity #2":
    "projects/web/src/api/event-rules.ts :: switch event.entity #2",
  "projects/web/src/api/useUserEvents.ts :: switch event.entity #3":
    "projects/web/src/api/event-rules.ts :: switch event.entity #3",
  "projects/web/src/api/useUserEvents.ts :: switch event.kind #1":
    "projects/web/src/api/event-rules.ts :: switch event.kind #1",
  "projects/web/src/api/useUserEvents.ts :: switch verdict.verdict #1":
    "projects/web/src/api/event-rules.ts :: switch verdict.verdict #1",
  "projects/web/src/api/useUserEvents.ts :: switch verdict.verdict #2":
    "projects/web/src/api/event-rules.ts :: switch verdict.verdict #2",
};

const root = fileURLToPath(new URL("../../..", import.meta.url));
const sources = readSources(root);

function fixture(text: string): Source[] {
  return [{ file: "projects/web/src/audit-fixture.ts", text }];
}

describe("repository enum fallback source guard", () => {
  it("rejects both undeclared unsafe sites and obsolete declarations", () => {
    expect(declarationErrors(scanSources(sources), DECLARED)).toEqual([]);
  }, 20_000);

  it("discovers a new switch, typed Record, and inline object lookup", () => {
    const sites = scanSources(
      fixture(
        'const labels: Record<"a", string> = { a: "A" };' +
          'function show(value: string) { switch (value) { case "a": break; }' +
          'return { a: "A" }[value]; }',
      ),
    );
    const errors = declarationErrors(sites, {});
    expect(errors.some((error) => error.includes("switch value"))).toBe(true);
    expect(errors.some((error) => error.includes("mapping labels"))).toBe(true);
    expect(errors.some((error) => error.includes("read { a:"))).toBe(true);
  });

  it("does not let a safe helper elsewhere excuse a bare map read", () => {
    const sites = scanSources(
      fixture(
        'import { enumLookup as lookup } from "@todou/shared";' +
          'const labels: Record<"a", string> = { a: "A" };' +
          "const alias = labels;" +
          'const safe = lookup(alias, input, () => "unknown");' +
          "const unsafe = labels[input];",
      ),
    );
    expect(declarationErrors(sites, {})).toEqual([
      expect.stringContaining("read labels[input]"),
    ]);
  });

  it("resolves named import aliases to the actual mapping declaration", () => {
    const sites = scanSources([
      {
        file: "projects/web/src/map.ts",
        text: 'export const labels = { a: "A" };',
      },
      {
        file: "projects/web/src/use.ts",
        text: 'import { labels as alias } from "./map.ts"; const value = alias[input];',
      },
    ]);
    expect(declarationErrors(sites, {})).toEqual([
      expect.stringContaining("read alias[input]"),
    ]);
  });

  it("expires declarations when an unsafe shape disappears or gains a fallback", () => {
    const sites = scanSources(
      fixture('const labels = { a: "A" }; const value = labels[input];'),
    );
    const unsafe = sites.find((site) => site.kind === "read");
    expect(unsafe).toBeDefined();
    const declared = {
      [unsafe!.id]:
        "Audited fixture input comes from a closed local option list.",
    };
    expect(declarationErrors(sites, declared)).toEqual([]);
    for (const text of [
      'const labels = { a: "A" }; const value = labels[input] ?? "unknown";',
      'const value = "removed";',
    ]) {
      expect(declarationErrors(scanSources(fixture(text)), declared)).toEqual([
        expect.stringContaining("STALE declaration"),
      ]);
    }
  });

  it("rejects a real STATUS_STYLE enumLookup-to-index deletion mutation", () => {
    const file = "projects/web/src/components/issue/spec-entry.tsx";
    const original = sources.find((source) => source.file === file);
    expect(original).toBeDefined();
    const before =
      /return enumLookup\(\s*STATUS_STYLE,\s*status,\s*\(\) => UNKNOWN_STATUS_STYLE,\s*"review_status",?\s*\);/;
    expect(original!.text).toMatch(before);
    const mutated = [
      {
        ...original!,
        text: original!.text.replace(
          before,
          "return STATUS_STYLE[status as SpecReviewStatus];",
        ),
      },
    ];
    // STATUS_LABEL still calls enumLookup in this same file. String-presence
    // checks would pass; the actual unprotected STATUS_STYLE read must fail.
    expect(declarationErrors(scanSources(mutated), {})).toEqual([
      expect.stringContaining("read STATUS_STYLE[status as SpecReviewStatus]"),
    ]);
  });

  it("ties hasOwn to this map/key and keeps literal-domain branches local", () => {
    const sites = scanSources(
      fixture(
        'const labels = { a: "A" };' +
          'const wrong = Object.hasOwn(labels, other) ? labels[input] : "unknown";' +
          'const right = Object.hasOwn(labels, input) ? labels[input] : "unknown";' +
          'if (input === "a") { consume(labels[input]); }',
      ),
    );
    expect(declarationErrors(sites, {})).toEqual([
      expect.stringContaining("read labels[input] #1"),
    ]);
  });

  it("preserves the measured 5db8c5c sites and 87 provenance declarations", () => {
    // The previously quoted 85 was not the current baseline. Freeze identities,
    // not the final total: new audited sites may be added without hiding losses.
    expect(baseline.revision).toBe("5db8c5c");
    expect(baseline.sites).toHaveLength(177);
    expect(baseline.declared).toHaveLength(87);
    const sites = new Map(scanSources(sources).map((site) => [site.id, site]));
    const baselineIds = new Set(baseline.sites.map(({ id }) => id));
    const relocatedIds = Object.values(RELOCATED_BASELINE_SITES);
    expect(new Set(relocatedIds).size).toBe(relocatedIds.length);
    for (const [original, relocated] of Object.entries(
      RELOCATED_BASELINE_SITES,
    )) {
      expect(baselineIds.has(original)).toBe(true);
      expect(sites.has(original)).toBe(false);
      expect(sites.has(relocated)).toBe(true);
    }
    expect(
      baseline.sites.map(({ id }) => {
        const site = sites.get(RELOCATED_BASELINE_SITES[id] ?? id);
        return site && { id, guarded: site.guarded };
      }),
    ).toEqual(baseline.sites);
    expect(
      baseline.declared.filter(
        (id) => !Object.hasOwn(DECLARED, RELOCATED_BASELINE_SITES[id] ?? id),
      ),
    ).toEqual([]);
  }, 20_000);

  it("rejects a fromEntries Record and bare wire read injected into real source", () => {
    const file = "projects/web/src/components/issue/spec-entry.tsx";
    const original = sources.find((source) => source.file === file);
    expect(original).toBeDefined();
    const mutated = [
      {
        ...original!,
        text: `${original!.text}
        const FUTURE_LABEL = Object.fromEntries([
          ["unreviewed", "Awaiting review"],
        ]) as Record<SpecReviewStatus, string>;
        function futureLabel(status: SpecReviewStatus) {
          return FUTURE_LABEL[status];
        }`,
      },
    ];
    const sites = scanSources(mutated);
    expect(sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `${file} :: mapping FUTURE_LABEL #1` }),
      ]),
    );
    expect(declarationErrors(sites, {})).toEqual([
      expect.stringContaining(
        `UNDECLARED ${file} :: read FUTURE_LABEL[status] #1`,
      ),
    ]);
  });

  it("discovers unasserted, annotated, asserted and explicit-return factories", () => {
    const sites = scanSources(
      fixture(`
      const plain = Object.fromEntries(entries);
      const asserted = build() as Record<Enum, string>;
      const annotated: Readonly<Record<Enum, string>> = build();
      const satisfied = build() satisfies Partial<Record<Enum, string>>;
      function make(): Record<Enum, string> { return dynamic; }
      const factoryAlias = make;
      const returned = factoryAlias();
      const arrow = (): Record<Enum, string> => dynamic;
      const fromArrow = arrow();
      consume(plain[key], asserted[key], annotated[key], satisfied[key],
        returned[key], fromArrow[key]);
    `),
    );
    expect(
      sites
        .filter((site) => site.kind === "mapping")
        .map((site) => site.id.split(" :: ")[1]),
    ).toEqual([
      "mapping annotated #1",
      "mapping asserted #1",
      "mapping fromArrow #1",
      "mapping plain #1",
      "mapping returned #1",
      "mapping satisfied #1",
    ]);
    const reads = sites.filter((site) => site.kind === "read");
    expect(reads.map((site) => site.id.split(" :: ")[1])).toEqual([
      "read annotated[key] #1",
      "read asserted[key] #1",
      "read fromArrow[key] #1",
      "read plain[key] #1",
      "read returned[key] #1",
      "read satisfied[key] #1",
    ]);
    expect(reads.every((site) => !site.guarded)).toBe(true);
    expect(declarationErrors(sites, {})).toEqual(
      reads.map((site) => expect.stringContaining(`UNDECLARED ${site.id} (`)),
    );
  });

  it("resolves factory imports, re-exports and aliases without crossing scopes", () => {
    const sites = scanSources([
      {
        file: "projects/web/src/maps.ts",
        text: `
        export const labels = Object.fromEntries(entries);
        export function make(): Record<Enum, string> { return dynamic; }
      `,
      },
      {
        file: "projects/web/src/barrel.ts",
        text: `
        export { labels as exportedLabels, make as exportedMake } from "./maps";
      `,
      },
      {
        file: "projects/web/src/use.ts",
        text: `
        import { exportedLabels as imported, exportedMake as create } from "./barrel";
        const alias = imported;
        const built = create();
        consume(alias[key], built[key]);
        function shadow(alias, create) {
          const built = create();
          return [alias[key], built[key]];
        }
        { const alias = external; consume(alias[key]); }
        function shadowsObject(Object) {
          const local = Object.fromEntries(entries);
          return local[key];
        }
      `,
      },
    ]);
    expect(declarationErrors(sites, {})).toEqual([
      expect.stringContaining("read alias[key] #1"),
      expect.stringContaining("read built[key] #1"),
    ]);
    expect(sites.filter((site) => site.kind === "mapping")).toHaveLength(2);
  });

  it("follows import-then-export factories and terminates import cycles", () => {
    const sites = scanSources([
      {
        file: "projects/web/src/maps.ts",
        text: "export function make(): Record<string, string> { return {}; }",
      },
      {
        file: "projects/web/src/barrel.ts",
        text: 'import { make } from "./maps"; export { make };',
      },
      {
        file: "projects/web/src/use.ts",
        text: 'import { make } from "./barrel"; const labels = make(); consume(labels[key]);',
      },
      {
        file: "projects/web/src/cycle-a.ts",
        text: 'import { make } from "./cycle-b"; export { make }; const labels = make(); consume(labels[key]);',
      },
      {
        file: "projects/web/src/cycle-b.ts",
        text: 'import { make } from "./cycle-a"; export { make };',
      },
    ]);
    expect(declarationErrors(sites, {})).toEqual([
      expect.stringContaining("projects/web/src/use.ts :: read labels[key] #1"),
    ]);
  });

  it("respects default and rest parameter shadows of factories and Object", () => {
    const sites = scanSources(
      fixture(`
      function make(): Record<string, string> { return {}; }
      function show(index: number, make = () => ["A"]) {
        const values = make(); return values[index];
      }
      function rest(...make) { const values = make(); return values[key]; }
      function shadowObject(Object = localObject) {
        const values = Object.fromEntries(entries); return values[key];
      }
    `),
    );
    expect(sites).toEqual([]);
  });

  it.each([
    'import Object from "./opaque";',
    'import * as Object from "./opaque";',
    "const { Object } = opaque;",
    "const { nested: { factory: Object = fallback } } = opaque;",
    "const [Object] = opaque;",
    "const [...Object] = opaque;",
    "const { ...Object } = opaque;",
  ])(
    "treats %s as an opaque shadow, without inferring a factory",
    (binding) => {
      expect(
        scanSources(
          fixture(`${binding}
          const values = Object.fromEntries(entries);
          consume(values[index]);`),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    "function local({ Object }) { BODY }",
    "function local([Object] = fallback) { BODY }",
    "try {} catch (Object) { BODY }",
    "try {} catch ({ factory: Object }) { BODY }",
    "{ const { Object } = opaque; BODY }",
    "for (const Object of objects) { BODY }",
    "for (let Object in objects) { BODY }",
    "for (let Object = opaque; ready; step()) { BODY }",
    "for (const { Object } of objects) { BODY }",
  ])("keeps an opaque shadow local to %s", (local) => {
    const body = `
      const values = Object.fromEntries(entries);
      consume(values[index]);`;
    const sites = scanSources(
      fixture(`
      ${local.replace("BODY", body)}
      const labels = Object.fromEntries(entries);
      consume(labels[wire]);
    `),
    );
    expect(sites.map((site) => site.id.split(" :: ")[1])).toEqual([
      "mapping labels #1",
      "read labels[wire] #1",
    ]);
    expect(declarationErrors(sites, {})).toEqual([
      expect.stringContaining("UNDECLARED"),
    ]);
  });

  it("keeps var loop bindings in the function but out of the module", () => {
    const sites = scanSources(
      fixture(`
      function local() {
        for (var Object of objects) {}
        const values = Object.fromEntries(entries);
        consume(values[index]);
      }
      const labels = Object.fromEntries(entries);
      consume(labels[wire]);
    `),
    );
    expect(sites.map((site) => site.id.split(" :: ")[1])).toEqual([
      "mapping labels #1",
      "read labels[wire] #1",
    ]);
  });

  it.each(['{ a: "A" }', "Object.fromEntries(entries)"])(
    "retains an initialized var %s that shares a parameter binding",
    (initializer) => {
      const sites = scanSources(
        fixture(`
        function local(labels) {
          var labels = ${initializer};
          consume(labels[wire]);
        }
      `),
      );
      expect(sites.map((site) => site.id.split(" :: ")[1])).toEqual([
        "mapping labels #1",
        "read labels[wire] #1",
      ]);
      expect(declarationErrors(sites, {})).toEqual([
        expect.stringContaining("read labels[wire] #1"),
      ]);
    },
  );

  it("does not resolve an uninitialized var redeclaration of a parameter", () => {
    expect(
      scanSources(
        fixture(`
      function local(Object) {
        var Object;
        const values = Object.fromEntries(entries);
        consume(values[index]);
      }
    `),
      ),
    ).toEqual([]);
  });

  it.each(["before", "after"])(
    "prefers an explicit factory over a star placed %s it",
    (order) => {
      const star = 'export * from "./other";';
      const explicit =
        "export function make(): Record<string, string> { return opaque; }";
      const sites = scanSources([
        {
          file: "projects/web/src/other.ts",
          text: 'export function make() { return ["ordinary array"]; }',
        },
        {
          file: "projects/web/src/barrel.ts",
          text: order === "before" ? star + explicit : explicit + star,
        },
        {
          file: "projects/web/src/use.ts",
          text: 'import { make } from "./barrel"; const labels = make(); consume(labels[wire]);',
        },
      ]);
      expect(declarationErrors(sites, {})).toEqual([
        expect.stringContaining("read labels[wire] #1"),
      ]);
    },
  );

  it.each([
    "export function make() { return opaque; }",
    "const local = () => opaque; export { local as make };",
    'export { local as make } from "./explicit";',
    'export { local as make } from "./unresolved";',
  ])("does not let a star factory override %s", (explicit) => {
    const sites = scanSources([
      {
        file: "projects/web/src/other.ts",
        text: "export function make(): Record<string, string> { return opaque; }",
      },
      {
        file: "projects/web/src/explicit.ts",
        text: "export function local() { return opaque; }",
      },
      {
        file: "projects/web/src/barrel.ts",
        text: `export * from "./other"; ${explicit}`,
      },
      {
        file: "projects/web/src/use.ts",
        text: 'import { make } from "./barrel"; const values = make(); consume(values[index]);',
      },
    ]);
    expect(sites).toEqual([]);
  });

  it("keeps factory safe reads local and expires their old declarations", () => {
    const sites = scanSources(
      fixture(`
      import { enumLookup as lookup } from "@todou/shared";
      const labels = Object.fromEntries(entries);
      const alias = labels;
      consume(lookup(alias, key, () => "unknown"));
      consume(labels[key] ?? "unknown");
      consume(labels[key] || "unknown");
      consume(labels["a"]);
      consume(Object.hasOwn(labels, key) ? labels[key] : "unknown");
      if (key === "a") consume(labels[key]);
      labels[key] = "A";
      consume(Object.hasOwn(labels, other) ? labels[key] : "unknown");
      function nested() { return labels[key]; }
    `),
    );
    expect(sites.filter((site) => site.kind === "read")).toHaveLength(7);
    expect(declarationErrors(sites, {})).toEqual([
      expect.stringContaining("read labels[key] #5"),
      expect.stringContaining("read labels[key] #6"),
    ]);
    const original = fixture(`
      const labels = Object.fromEntries(entries);
      consume(labels[key]);
    `);
    const id = scanSources(original).find((site) => site.kind === "read")!.id;
    const declared = {
      [id]: "Closed fixture producer from a local option catalog.",
    };
    expect(declarationErrors(scanSources(original), declared)).toEqual([]);
    expect(
      declarationErrors(
        scanSources(
          fixture(`
      const labels = Object.fromEntries(entries);
      consume(labels[key] ?? "unknown");
    `),
        ),
        declared,
      ),
    ).toEqual([`STALE declaration: ${id}`]);
  });

  it("does not infer dictionary results from nested Record syntax or data casts", () => {
    const sites = scanSources(
      fixture(`
      const state = useState<Record<Enum, string>>(() => Object.fromEntries(entries));
      const callback = register((): Record<Enum, string> => dynamic);
      const argument = register(dynamic as Record<Enum, string>);
      const nested = build() as { labels: Record<Enum, string> };
      const array = build() as Record<Enum, string>[];
      const promise: Promise<Record<Enum, string>> = build();
      const callable = build() as (() => Record<Enum, string>);
      const incomingAlias = incoming as Record<Enum, string>;
      const empty = {} as Record<Enum, string>;
      consume(state[key], callback[key], argument[key], nested[key], array[key],
        promise[key], callable[key], incomingAlias[key], empty[key]);
    `),
    );
    expect(sites).toEqual([]);
  });
});
