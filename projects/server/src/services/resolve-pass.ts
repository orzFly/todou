/**
 * Resolve references when they are submitted, and store the answer (T-266).
 *
 * Every markdown field this server accepts goes through here on its way into
 * the database. A reference the author wrote as `#12` is stored as
 * `[#12](/projects/7/issues/12)`: the spelling they typed as the link text,
 * the target's permanent address as the destination. What is stored is what
 * is returned, so reading a body and saving it back changes nothing.
 *
 * That collapses the two answers this codebase used to keep apart — the text
 * and the events born from it — into one pass over one anchor: this project,
 * this instant, this author's visibility. There is no origin project, no
 * edit anchor and no slug time window left to disagree with each other.
 *
 * A candidate that cannot be resolved stays exactly as written and records
 * nothing. A link is a claim that the target existed when the text was saved,
 * so guessing one would be the very error this replaces.
 */

import type { AgentContext, ScanConfig } from "@todou/shared";
import {
  findMarkdownLinks,
  hrefFor,
  type LinkTarget,
  linkFor,
  type MarkdownLink,
  maskForResolve,
  type ReferenceToken,
  type ResolvedTarget,
  type ResolveEdit,
  scanReferenceTokens,
  spliceResolved,
} from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext, DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  attachments,
  comments,
  issueEvents,
  issues,
} from "../db/project-schema.ts";
import { projects } from "../db/system-schema.ts";
import { type ProjectRow, projectRoleOf, routeInfoOf } from "./access.ts";
import type { ReferenceInputs } from "./cross-references.ts";
import { refPrefixAt } from "./references.ts";
import { aliasOf, currentAddressOf } from "./relocation.ts";
import { live, referenceable } from "./trash.ts";

/** The content being saved, so a card never records a reference to itself. */
export type ResolveSource = { issueNumber: number; commentId?: number };

/** A card an event lands on, at the address the address book gives today. */
export type ReferenceTarget = { projectId: number; number: number };

export type ResolveResult = {
  /** What goes into the database, and what every read returns. */
  storedText: string;
  /** Cards in this project: recorded inside the writing transaction. */
  local: number[];
  /** Cards elsewhere: recorded after the commit, best effort. */
  cross: ReferenceTarget[];
};

/** The grammar as this project's numbering sees it right now. */
function anchorConfig(
  inputs: ReferenceInputs,
  internalPrefix: string | null,
  at: Date,
): ScanConfig {
  return {
    internalPrefix,
    autolinks: inputs.autolinks,
    cross: {
      slugs: inputs.slugs,
      directory: inputs.directory,
      slugEntries: inputs.slugEntries,
      at: at.toISOString(),
    },
  };
}

/** How a candidate names the project it points into. */
type ProjectPointer =
  | { kind: "here" }
  | { kind: "slug"; slug: string }
  | { kind: "id"; id: number };

type CandidateTarget =
  | {
      kind: "issue";
      project: ProjectPointer;
      number: number;
      commentId?: number;
    }
  /** A bare `#comment-M`: the card is whichever one carries that comment. */
  | { kind: "loose-comment"; commentId: number }
  | {
      kind: "attachment";
      project: ProjectPointer;
      id: number;
      variant: "download" | "view";
      name: string | null;
    };

type Candidate = {
  start: number;
  end: number;
  /**
   * The link text to write. Null means only the destination is replaced,
   * which is how an existing link keeps the words the author chose.
   */
  asTyped: string | null;
  target: CandidateTarget;
};

function pointerOf(target: LinkTarget): ProjectPointer {
  return target.project.kind === "id"
    ? { kind: "id", id: target.project.id }
    : { kind: "slug", slug: target.project.slug };
}

function candidateOfToken(token: ReferenceToken): Candidate | null {
  if (token.type === "issue") {
    return {
      start: token.start,
      end: token.end,
      asTyped: token.text,
      target: {
        kind: "issue",
        project:
          token.slug === null
            ? { kind: "here" }
            : { kind: "slug", slug: token.slug },
        number: token.number,
        ...(token.commentId === undefined
          ? {}
          : { commentId: token.commentId }),
      },
    };
  }
  if (token.type === "comment") {
    return {
      start: token.start,
      end: token.end,
      asTyped: token.text,
      target: { kind: "loose-comment", commentId: token.commentId },
    };
  }
  // An autolink names another tracker, which has no address here to anchor
  // on. It stays a token and keeps being expanded when the text is rendered.
  return null;
}

function candidateOfLink(link: MarkdownLink): Candidate | null {
  const target = link.target;
  if (target === null) return null;
  // Already anchored on an id, which is the form this pass produces. Leaving
  // it alone is what makes a second pass over stored text a no-op — and what
  // keeps a later move from being written into the text again.
  if (target.project.kind === "id") return null;
  const project = pointerOf(target);
  const base = link.bare
    ? { start: link.start, end: link.end, asTyped: link.href }
    : { start: link.hrefStart, end: link.hrefEnd, asTyped: null };
  return {
    ...base,
    target:
      target.kind === "issue"
        ? {
            kind: "issue",
            project,
            number: target.number,
            ...(target.commentId === undefined
              ? {}
              : { commentId: target.commentId }),
          }
        : {
            kind: "attachment",
            project,
            id: target.id,
            variant: target.variant,
            name: target.name,
          },
  };
}

/**
 * Everything a resolve needs that is not the text: which project a bare `#N`
 * means, whose database minted the comment ids, who may see what, and how
 * alive a target has to be.
 *
 * A submission and the one-off migration differ in exactly these, and in the
 * scan config they pass alongside. Sharing the resolution itself is the point:
 * the migration's whole job is to produce what a submission would have.
 */
export type ResolveWorld = {
  ctx: DbContext;
  /** The project a bare token names, and where its comment ids live. */
  here: ProjectRow;
  hereDb: Db;
  /**
   * The author gate. A submission refuses to write into a project its author
   * cannot read, so a reference can neither spam a stranger's timeline nor
   * probe whether a project exists. The migration has no author to ask about
   * and lets everything through: it is rewriting text that already names the
   * target in the clear.
   */
  mayRead: (project: ProjectRow) => Promise<boolean>;
  /**
   * `referenceable` for a submission — a card in the trash or mid-move takes
   * no new reference. `exists` for the migration, which is recording what the
   * text already meant rather than making a new claim.
   */
  gate: "referenceable" | "exists";
  /** Absolute URLs count as internal only against a configured origin. */
  origin?: string | undefined;
};

export type ResolvedText = {
  storedText: string;
  /** Cards named, at their current addresses, de-duplicated. */
  cards: ReferenceTarget[];
  /** Candidates left exactly as written, for a dry run to report. */
  unresolved: string[];
};

/** Mask, scan, resolve and splice one segment of markdown. */
export async function resolveText(
  world: ResolveWorld,
  text: string,
  config: ScanConfig,
): Promise<ResolvedText> {
  const links = findMarkdownLinks(text, { origin: world.origin });
  const masked = maskForResolve(text, links);

  const candidates: Candidate[] = [];
  for (const token of scanReferenceTokens(masked, config)) {
    if (token.type === "text") continue;
    const candidate = candidateOfToken(token);
    if (candidate !== null) candidates.push(candidate);
  }
  for (const link of links) {
    const candidate = candidateOfLink(link);
    if (candidate !== null) candidates.push(candidate);
  }
  if (candidates.length === 0) {
    return { storedText: text, cards: [], unresolved: [] };
  }

  const resolver = new Resolver(world);
  const edits: ResolveEdit[] = [];
  const unresolved: string[] = [];
  const cards = new Map<string, ReferenceTarget>();
  for (const candidate of candidates) {
    const resolved = await resolver.resolve(candidate.target);
    if (resolved === null) {
      unresolved.push(text.slice(candidate.start, candidate.end));
      continue;
    }
    edits.push({
      start: candidate.start,
      end: candidate.end,
      text:
        candidate.asTyped === null
          ? hrefFor(resolved.target)
          : linkFor(resolved.target, candidate.asTyped),
    });
    const card = resolved.card;
    if (card !== null) cards.set(`${card.projectId}/${card.number}`, card);
  }
  return {
    storedText: spliceResolved(text, edits),
    cards: [...cards.values()],
    unresolved,
  };
}

/**
 * Resolve a submission and hand back what to store.
 *
 * Runs before the writing transaction opens, because deciding whether a
 * candidate in another project is real means reading that project's database
 * — a second connection a transaction has no business holding open. The
 * events it announces are therefore a statement about the moment of the scan;
 * the local ones are re-checked under the transaction's own lock, and a card
 * that disappears in between costs a timeline entry, never the text.
 */
export async function resolveContent(args: {
  ctx: AppContext;
  db: Db;
  project: ProjectRow;
  actor: UserRow;
  inputs: ReferenceInputs;
  text: string;
  /**
   * The card this content belongs to, so it records no reference to itself.
   * Null while a card is being created, which has no number yet and cannot
   * be the target of anything.
   */
  self: ReferenceTarget | null;
}): Promise<ResolveResult> {
  const { ctx, db, project, actor, inputs, text, self } = args;
  const at = new Date();
  const resolved = await resolveText(
    {
      ctx,
      here: project,
      hereDb: db,
      mayRead: async (target) =>
        (await projectRoleOf(ctx, target, actor)) !== null,
      gate: "referenceable",
      origin: ctx.config.http.public_origin,
    },
    text,
    anchorConfig(inputs, await refPrefixAt(db, project.id, at), at),
  );

  const local: number[] = [];
  const cross: ReferenceTarget[] = [];
  for (const card of resolved.cards) {
    // A card does not announce a reference to itself, the way it never did.
    if (
      self !== null &&
      card.projectId === self.projectId &&
      card.number === self.number
    ) {
      continue;
    }
    if (card.projectId === project.id) local.push(card.number);
    else cross.push(card);
  }
  return { storedText: resolved.storedText, local, cross };
}

/** What a candidate turned out to name, and the card an event owes. */
type Resolution = {
  target: ResolvedTarget;
  /** Null for an attachment, which no card's timeline hears about. */
  card: ReferenceTarget | null;
};

/**
 * One resolve pass's view of the world, with the lookups it repeats cached.
 *
 * A body naming five cards in the same project would otherwise open that
 * project's database five times and ask for the author's role five times.
 */
class Resolver {
  private readonly projectByRef = new Map<string, ProjectRow | null>();
  private readonly readable = new Map<number, boolean>();
  private readonly issueLive = new Map<string, boolean>();

  private readonly ctx: DbContext;
  private readonly db: Db;
  private readonly project: ProjectRow;
  private readonly world: ResolveWorld;

  constructor(world: ResolveWorld) {
    this.world = world;
    this.ctx = world.ctx;
    this.db = world.hereDb;
    this.project = world.here;
  }

  async resolve(target: CandidateTarget): Promise<Resolution | null> {
    if (target.kind === "loose-comment")
      return this.looseComment(target.commentId);
    const named = await this.projectOf(target.project);
    if (named === null) return null;
    if (target.kind === "attachment") return this.attachment(named, target);
    return this.issue(named, target.number, target.commentId);
  }

  /** The project a pointer names, or null when nothing here answers to it. */
  private async projectOf(pointer: ProjectPointer): Promise<ProjectRow | null> {
    if (pointer.kind === "here") return this.project;
    const key = pointer.kind === "id" ? `#${pointer.id}` : pointer.slug;
    const cached = this.projectByRef.get(key);
    if (cached !== undefined) return cached;
    const system = this.ctx.router.system();
    const rows = await system
      .select()
      .from(projects)
      .where(
        pointer.kind === "id"
          ? eq(projects.id, pointer.id)
          : eq(projects.slug, pointer.slug),
      );
    const row = rows[0] ?? null;
    this.projectByRef.set(key, row);
    return row;
  }

  private async projectById(id: number): Promise<ProjectRow | null> {
    return this.projectOf({ kind: "id", id });
  }

  /**
   * The author gate, unchanged from what recording a cross reference always
   * did: nobody writes into a project they cannot read, so a reference can
   * neither spam a stranger's timeline nor probe whether a project exists.
   */
  private async mayRead(project: ProjectRow): Promise<boolean> {
    const cached = this.readable.get(project.id);
    if (cached !== undefined) return cached;
    const may = await this.world.mayRead(project);
    this.readable.set(project.id, may);
    return may;
  }

  private async dbOf(project: ProjectRow): Promise<Db> {
    if (project.id === this.project.id) return this.db;
    return this.ctx.router.forProject(routeInfoOf(project));
  }

  /** Whether the card is there and willing to take a reference right now. */
  private async cardLive(
    project: ProjectRow,
    number: number,
  ): Promise<boolean> {
    const key = `${project.id}/${number}`;
    const cached = this.issueLive.get(key);
    if (cached !== undefined) return cached;
    const db = await this.dbOf(project);
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, project.id),
          eq(issues.number, number),
          this.world.gate === "referenceable" ? referenceable : live,
        ),
      );
    const there = rows.length > 0;
    this.issueLive.set(key, there);
    return there;
  }

  private async issue(
    named: ProjectRow,
    number: number,
    commentId: number | undefined,
  ): Promise<Resolution | null> {
    const system = this.ctx.router.system();
    const moved = await currentAddressOf(system, named.id, number);
    const address = moved ?? { projectId: named.id, number };
    const target =
      address.projectId === named.id
        ? named
        : await this.projectById(address.projectId);
    if (target === null) return null;
    if (!(await this.mayRead(target))) return null;
    if (!(await this.cardLive(target, address.number))) return null;

    let anchor = commentId;
    if (commentId !== undefined && moved !== null) {
      // The card carried its comments to a database that numbers them from
      // its own sequence. Writing the id as typed would point the anchor at
      // a real, unrelated comment, so an anchor that cannot be translated
      // takes the whole reference down with it.
      const alias = await aliasOf(system, "comment", named.id, commentId);
      if (alias === null || alias.projectId !== target.id) return null;
      anchor = alias.id;
    }
    return {
      target: {
        kind: "issue",
        projectId: target.id,
        number: address.number,
        ...(anchor === undefined ? {} : { commentId: anchor }),
      },
      card: { projectId: target.id, number: address.number },
    };
  }

  /**
   * A bare `#comment-M` names whatever card carries that comment. The id was
   * minted by this project, so the search starts here and falls back to the
   * alias table for a comment that has since moved away.
   */
  private async looseComment(commentId: number): Promise<Resolution | null> {
    const here = await this.db
      .select({ number: issues.number })
      .from(comments)
      .innerJoin(issues, eq(comments.issueId, issues.id))
      .where(
        and(
          eq(comments.projectId, this.project.id),
          eq(comments.id, commentId),
          this.world.gate === "referenceable" ? referenceable : live,
        ),
      );
    const number = here[0]?.number;
    if (number !== undefined) {
      return {
        target: {
          kind: "issue",
          projectId: this.project.id,
          number,
          commentId,
        },
        card: { projectId: this.project.id, number },
      };
    }

    const alias = await aliasOf(
      this.ctx.router.system(),
      "comment",
      this.project.id,
      commentId,
    );
    if (alias === null) return null;
    const target = await this.projectById(alias.projectId);
    if (target === null || !(await this.mayRead(target))) return null;
    const db = await this.dbOf(target);
    const rows = await db
      .select({ number: issues.number })
      .from(comments)
      .innerJoin(issues, eq(comments.issueId, issues.id))
      .where(
        and(
          eq(comments.projectId, target.id),
          eq(comments.id, alias.id),
          this.world.gate === "referenceable" ? referenceable : live,
        ),
      );
    const moved = rows[0]?.number;
    if (moved === undefined) return null;
    return {
      target: {
        kind: "issue",
        projectId: target.id,
        number: moved,
        commentId: alias.id,
      },
      card: { projectId: target.id, number: moved },
    };
  }

  /**
   * An attachment link, resolved the same way and for the same reason: the
   * id is project-scoped, so a move renumbers it and a stored slug-form URL
   * would fetch whatever now sits at that number.
   */
  private async attachment(
    named: ProjectRow,
    target: Extract<CandidateTarget, { kind: "attachment" }>,
  ): Promise<Resolution | null> {
    const system = this.ctx.router.system();
    const alias = await aliasOf(system, "attachment", named.id, target.id);
    const address = alias ?? { projectId: named.id, id: target.id };
    const home =
      address.projectId === named.id
        ? named
        : await this.projectById(address.projectId);
    if (home === null || !(await this.mayRead(home))) return null;
    const db = await this.dbOf(home);
    const rows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(eq(attachments.projectId, home.id), eq(attachments.id, address.id)),
      );
    if (rows.length === 0) return null;
    return {
      target: {
        kind: "attachment",
        projectId: home.id,
        id: address.id,
        variant: target.variant,
        name: target.name,
      },
      card: null,
    };
  }
}

/**
 * Land `referenced` events on the cards this content names, in the same
 * project and in the same transaction.
 *
 * The share lock is what makes a single-transaction move wait: it takes FOR
 * UPDATE on the same row, and without it an event could land on the card
 * between the copy and the source-side cleanup that deletes it again.
 */
export async function recordLocalReferences(
  tx: Db,
  project: ProjectRow,
  actorId: number,
  source: ResolveSource,
  numbers: number[],
  agentContext: AgentContext | null,
): Promise<Array<{ eventId: number; issueNumber: number }>> {
  if (numbers.length === 0) return [];
  const targets = await tx
    .select({ id: issues.id, number: issues.number })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, project.id),
        inArray(issues.number, numbers),
        referenceable,
      ),
    )
    .for("share");
  return insertReferenceEvents(
    tx,
    project,
    project,
    actorId,
    source,
    targets,
    agentContext,
  );
}

/**
 * The same events for cards in other projects, after the source write has
 * committed — the target lives in another database, so it can never join
 * that transaction. Best-effort by consequence: a target that fails costs one
 * timeline entry, never the content that mentioned it, and the next edit
 * replays the whole set.
 */
export async function recordCrossReferences(
  ctx: AppContext,
  actor: UserRow,
  project: ProjectRow,
  source: ResolveSource,
  targets: ReferenceTarget[],
  agentContext: AgentContext | null = null,
): Promise<void> {
  const byProject = new Map<number, number[]>();
  for (const target of targets) {
    byProject.set(target.projectId, [
      ...(byProject.get(target.projectId) ?? []),
      target.number,
    ]);
  }
  for (const [projectId, numbers] of byProject) {
    try {
      const rows = await ctx.router
        .system()
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));
      const target = rows[0];
      if (target === undefined) continue;
      const db = await ctx.router.forProject(routeInfoOf(target));
      const cards = await db
        .select({ id: issues.id, number: issues.number })
        .from(issues)
        .where(
          and(
            eq(issues.projectId, target.id),
            inArray(issues.number, numbers),
            referenceable,
          ),
        );
      const created = await insertReferenceEvents(
        db,
        target,
        project,
        actor.id,
        source,
        cards,
        agentContext,
      );
      for (const event of created) {
        ctx.bus.publish(target.id, {
          entity: "timeline",
          id: event.eventId,
          action: "created",
          issue_number: event.issueNumber,
        });
      }
    } catch (err) {
      console.error(`reference into project ${projectId} failed`, err);
    }
  }
}

/**
 * Insert one `referenced` event per target that does not already carry this
 * one, and report what was written so the caller can announce it.
 *
 * The de-duplication key is read three ways because three generations of
 * payload are in the database at once: id-bearing rows, slug-only rows from
 * before ids were written, and local rows from before the two event types
 * merged, which name no project at all. Every edit replays the whole set, so
 * a key that failed to match an old row would add a duplicate on each save.
 * The `refs migrate` command retires the older two shapes.
 */
async function insertReferenceEvents(
  db: Db,
  target: ProjectRow,
  source: ProjectRow,
  actorId: number,
  from: ResolveSource,
  cards: Array<{ id: number; number: number }>,
  agentContext: AgentContext | null,
): Promise<Array<{ eventId: number; issueNumber: number }>> {
  if (cards.length === 0) return [];
  const existing = await db
    .select({ issueId: issueEvents.issueId, payload: issueEvents.payload })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.projectId, target.id),
        inArray(issueEvents.type, ["referenced", "cross_referenced"]),
        inArray(
          issueEvents.issueId,
          cards.map((card) => card.id),
        ),
      ),
    );
  const seen = new Set<string>();
  for (const row of existing) {
    const payload = row.payload as {
      by_project?: string;
      by_project_id?: number;
      by_issue?: number;
    };
    if (payload.by_project_id !== undefined) {
      seen.add(
        `${row.issueId}:id:${payload.by_project_id}:${payload.by_issue}`,
      );
    }
    if (payload.by_project !== undefined) {
      seen.add(`${row.issueId}:slug:${payload.by_project}:${payload.by_issue}`);
    }
    if (
      payload.by_project_id === undefined &&
      payload.by_project === undefined
    ) {
      seen.add(`${row.issueId}:here:${payload.by_issue}`);
    }
  }

  const created: Array<{ eventId: number; issueNumber: number }> = [];
  for (const card of cards) {
    const keys = [
      `${card.id}:id:${source.id}:${from.issueNumber}`,
      `${card.id}:slug:${source.slug}:${from.issueNumber}`,
      ...(source.id === target.id
        ? [`${card.id}:here:${from.issueNumber}`]
        : []),
    ];
    if (keys.some((key) => seen.has(key))) continue;
    const inserted = await db
      .insert(issueEvents)
      .values({
        projectId: target.id,
        issueId: card.id,
        actorId,
        type: "referenced",
        agentContext,
        payload: {
          by_project_id: source.id,
          by_issue: from.issueNumber,
          ...(from.commentId === undefined
            ? {}
            : { by_comment: from.commentId }),
        },
      })
      .returning({ id: issueEvents.id });
    const id = inserted[0]?.id;
    if (id !== undefined)
      created.push({ eventId: id, issueNumber: card.number });
  }
  return created;
}
