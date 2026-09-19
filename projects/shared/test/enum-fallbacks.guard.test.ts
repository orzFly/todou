import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  declarationErrors,
  readSources,
  type Source,
  scanSources,
} from "./enum-fallback-audit.ts";

/**
 * Full census of TypeScript/TSX under projects/{shared,web,cli,server}/src.
 * Every switch and fixed-key Record is discovered; computed lookups discover
 * untyped and inline maps too. Local aliases and named imports/re-exports are
 * resolved syntactically. Names never decide whether a key is server-origin.
 *
 * DECLARED documents actual producers for shapes the scanner cannot prove.
 * Add one only after tracing the input. Removing a lookup/default-less switch,
 * or adding a recognized guard, makes its declaration stale and fails the test.
 * Duplicate expressions have an occurrence ordinal so a new bare read fails.
 *
 * Boundaries: no interprocedural taint/type inference, namespace/dynamic imports,
 * destructured aliases, generated string-code parsing, Map.get, or if/ternary
 * enum dispatch census. A default's semantics and a fallback's wording need
 * behavioral tests. ??/|| proves a fallback, not prototype-key safety; own-key
 * safety for wire mappings is covered by enumLookup and its behavioral tests.
 * Provenance declarations require review if an upstream producer changes.
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
  "projects/web/src/api/useUserEvents.ts :: switch event.entity #1":
    "Parsed SSE boundary: onChangeFrame uses CrossChangeEventSchema.parse and onMeFrame uses MeEventSchema.parse; BroadcastChannel messages re-enter these same handlers.",
  "projects/web/src/api/useUserEvents.ts :: switch event.kind #1":
    "Parsed SSE boundary: onChangeFrame uses CrossChangeEventSchema.parse and onMeFrame uses MeEventSchema.parse; BroadcastChannel messages re-enter these same handlers.",
  "projects/web/src/api/useUserEvents.ts :: switch verdict.verdict #1":
    "Closed client producer: issueListVerdict constructs contains/read/unknown local literals; entryWantsRefetch switches on that computed result, not HTTP enum fields.",
  "projects/web/src/api/useUserEvents.ts :: switch verdict.verdict #2":
    "Closed client producer: issueListVerdict constructs contains/read/unknown local literals; entryWantsRefetch switches on that computed result, not HTTP enum fields.",
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
});
