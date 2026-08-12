import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractIssueRefs } from "../src/services/references.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("extractIssueRefs", () => {
  it("finds #N references and dedupes", () => {
    expect(extractIssueRefs("see #12, #3 and again #12")).toEqual([12, 3]);
  });
  it("ignores anchors inside words", () => {
    expect(extractIssueRefs("channel#4chat")).toEqual([]);
  });
  it("matches at start of text", () => {
    expect(extractIssueRefs("#7 first")).toEqual([7]);
  });
  it("ignores refs inside fenced code blocks", () => {
    expect(
      extractIssueRefs("before #1\n```\ninside #2\n```\nafter #3"),
    ).toEqual([1, 3]);
  });
  it("ignores refs inside tilde fences and unclosed fences", () => {
    expect(extractIssueRefs("~~~txt\n#4\n~~~\n#5")).toEqual([5]);
    expect(extractIssueRefs("```\n#6 never closed")).toEqual([]);
  });
  it("requires the closing fence to be at least as long", () => {
    expect(extractIssueRefs("````\n```\nstill code #8\n````\n#9")).toEqual([9]);
  });
  it("ignores refs inside inline code", () => {
    expect(extractIssueRefs("fix `#10` but keep #11")).toEqual([11]);
    expect(extractIssueRefs("``a `#12` b`` and #13")).toEqual([13]);
  });
});

describe.each(PLACEMENTS)("issues domain (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    slug = `issues-${placement.replaceAll(/[^a-z]/g, "")}`;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Issues" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createIssue(body: Record<string, unknown>) {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function statusesOf() {
    return json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: { cookie },
      }),
    );
  }

  async function timelineOf(number: number, qs = "") {
    return json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/timeline${qs}`,
        { headers: { cookie } },
      ),
    );
  }

  it("creates issues with sequential numbers and an opened event", async () => {
    const first = await createIssue({ title: "First potato" });
    expect(first.number).toBe(1);
    expect(first.status.name).toBe("Todo");

    const second = await createIssue({ title: "Second potato" });
    expect(second.number).toBe(2);

    const timeline = await timelineOf(1);
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0].type).toBe("event");
    expect(timeline.items[0].event_type).toBe("opened");
  });

  it("creates issues in the project default status when one is set", async () => {
    const statuses = await statusesOf();
    const progress = statuses.find(
      (s: { name: string }) => s.name === "In Progress",
    );
    const done = statuses.find((s: { name: string }) => s.name === "Done");
    const setDefault = (id: number, is_default: boolean) =>
      t.app.request(`/api/projects/${slug}/statuses/${id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ is_default }),
      });

    await setDefault(progress.id, true);
    const defaulted = await createIssue({ title: "Lands in the default" });
    expect(defaulted.status.name).toBe("In Progress");

    // An explicit status_id still wins over the default.
    const explicit = await createIssue({
      title: "Explicit status",
      status_id: done.id,
    });
    expect(explicit.status.name).toBe("Done");

    // Clearing the default restores first-by-position behavior.
    await setDefault(progress.id, false);
    const fallback = await createIssue({ title: "Back to first" });
    expect(fallback.status.name).toBe("Todo");
  });

  it("filters the list by exact numbers", async () => {
    const a = await createIssue({ title: "Ref target A" });
    const b = await createIssue({ title: "Ref target B" });
    const page = await json(
      await t.app.request(
        `/api/projects/${slug}/issues?numbers=${a.number},${b.number},999999`,
        { headers: { cookie } },
      ),
    );
    expect(page.items.map((i: { number: number }) => i.number).sort()).toEqual(
      [a.number, b.number].sort(),
    );
  });

  it("allocates unique numbers under concurrent creation", async () => {
    const created = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        createIssue({ title: `Concurrent ${i}` }),
      ),
    );
    const numbers = created.map((c) => c.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("polls the timeline forward with types and actor filters", async () => {
    const issue = await createIssue({ title: "Watched potato" });
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    const bob = await addUserWithToken(t.ctx, `watcher-${placement}`);
    await t.app.request(`/api/projects/${slug}/members/${bob.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "writer" }),
    });

    // Baseline: cursor of the newest entry (the opened event).
    const tail = await timelineOf(issue.number, "?last=1&limit=1");
    expect(tail.next_cursor).toBeTruthy();

    const comment = (who: Record<string, string>, body: string) =>
      t.app.request(`/api/projects/${slug}/issues/${issue.number}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify({ body }),
      });
    await comment({ cookie }, "mine");
    await comment(bob.headers, "from bob");
    const statuses = await statusesOf();
    const done = statuses.find((s: { name: string }) => s.name === "Done");
    await t.app.request(`/api/projects/${slug}/issues/${issue.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status_id: done.id }),
    });

    // Everything after the baseline, in order.
    const all = await timelineOf(issue.number, `?after=${tail.next_cursor}`);
    expect(all.items.map((i: { type: string }) => i.type)).toEqual([
      "comment",
      "comment",
      "event",
    ]);

    // types= keeps only the named kinds.
    const onlyComments = await timelineOf(
      issue.number,
      `?after=${tail.next_cursor}&types=comment`,
    );
    expect(onlyComments.items.map((i: { body: string }) => i.body)).toEqual([
      "mine",
      "from bob",
    ]);

    // exclude_actor drops my own writes: bob's comment survives, and the
    // returned cursor resumes cleanly after another foreign comment lands.
    const foreign = await timelineOf(
      issue.number,
      `?after=${tail.next_cursor}&types=comment&exclude_actor=${me.id}`,
    );
    expect(foreign.items.map((i: { body: string }) => i.body)).toEqual([
      "from bob",
    ]);
    await comment(bob.headers, "bob again");
    const resumed = await timelineOf(
      issue.number,
      `?after=${foreign.next_cursor}&types=comment&exclude_actor=${me.id}`,
    );
    expect(resumed.items.map((i: { body: string }) => i.body)).toEqual([
      "bob again",
    ]);

    // Nothing new → empty page, null cursor (caller keeps its own).
    const drained = await timelineOf(
      issue.number,
      `?after=${resumed.next_cursor}`,
    );
    expect(drained.items).toEqual([]);
    expect(drained.next_cursor).toBeNull();

    const bad = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/timeline?types=bogus`,
      { headers: { cookie } },
    );
    expect(bad.status).toBe(422);
  });

  it("streams project-wide activity tagged with issue numbers", async () => {
    const a = await createIssue({ title: "Activity A" });
    const b = await createIssue({ title: "Activity B" });
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    const carol = await addUserWithToken(t.ctx, `carol-${placement}`);
    await t.app.request(`/api/projects/${slug}/members/${carol.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "writer" }),
    });

    const activity = async (qs: string) =>
      json(
        await t.app.request(`/api/projects/${slug}/activity${qs}`, {
          headers: { cookie },
        }),
      );

    // Bootstrap a "now" cursor, then generate cross-issue activity.
    const tail = await activity("?last=1&limit=1");
    expect(tail.next_cursor).toBeTruthy();

    await t.app.request(`/api/projects/${slug}/issues/${a.number}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", ...carol.headers },
      body: JSON.stringify({ body: "hi from carol" }),
    });
    const statuses = await statusesOf();
    const progress = statuses.find(
      (s: { name: string }) => s.name === "In Progress",
    );
    await t.app.request(`/api/projects/${slug}/issues/${b.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status_id: progress.id }),
    });

    const all = await activity(`?after=${tail.next_cursor}`);
    expect(
      all.items.map((i: { type: string; issue_number: number }) => [
        i.type,
        i.issue_number,
      ]),
    ).toEqual([
      ["comment", a.number],
      ["event", b.number],
    ]);

    // "Anyone but me" — the orchestrator/unread filter.
    const foreign = await activity(
      `?after=${tail.next_cursor}&exclude_actor=${me.id}`,
    );
    expect(
      foreign.items.map((i: { issue_number: number }) => i.issue_number),
    ).toEqual([a.number]);

    // Type filters work the same as on the issue timeline.
    const events = await activity(
      `?after=${tail.next_cursor}&types=status_changed`,
    );
    expect(
      events.items.map((i: { issue_number: number }) => i.issue_number),
    ).toEqual([b.number]);

    // Issue-timeline cursors are interchangeable with activity cursors.
    const issueTail = await timelineOf(a.number, "?last=1&limit=1");
    const viaTimelineCursor = await activity(`?after=${issueTail.next_cursor}`);
    expect(
      viaTimelineCursor.items.map(
        (i: { issue_number: number }) => i.issue_number,
      ),
    ).toEqual([b.number]);
  });

  it("records status transitions as closed/reopened/status_changed", async () => {
    const statuses = await statusesOf();
    const done = statuses.find((s: { name: string }) => s.name === "Done");
    const progress = statuses.find(
      (s: { name: string }) => s.name === "In Progress",
    );
    const issue = await createIssue({ title: "Lifecycle" });

    const patch = (body: Record<string, unknown>) =>
      t.app.request(`/api/projects/${slug}/issues/${issue.number}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify(body),
      });

    await patch({ status_id: progress.id });
    await patch({ status_id: done.id });
    await patch({ status_id: progress.id });

    const timeline = await timelineOf(issue.number);
    const kinds = timeline.items
      .filter((i: { type: string }) => i.type === "event")
      .map((i: { event_type: string }) => i.event_type);
    expect(kinds).toEqual(["opened", "status_changed", "closed", "reopened"]);
  });

  it("records title/assignee/label changes with payloads", async () => {
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    const label = await json(
      await t.app.request(`/api/projects/${slug}/labels`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: `evt-${placement}`, color: "#112233" }),
      }),
    );
    const issue = await createIssue({ title: "Before" });

    const res = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          title: "After",
          assignee_ids: [me.id],
          label_ids: [label.id],
        }),
      },
    );
    expect(res.status).toBe(200);
    const updated = await json(res);
    expect(updated.title).toBe("After");
    expect(updated.assignees.map((a: { id: number }) => a.id)).toEqual([me.id]);
    expect(updated.labels[0].name).toBe(`evt-${placement}`);

    const timeline = await timelineOf(issue.number);
    const byType = new Map(
      timeline.items
        .filter((i: { type: string }) => i.type === "event")
        .map((i: { event_type: string; payload: unknown }) => [
          i.event_type,
          i.payload,
        ]),
    );
    expect(byType.get("title_changed")).toEqual({
      from: "Before",
      to: "After",
    });
    expect(byType.has("assigned")).toBe(true);
    expect(byType.has("label_added")).toBe(true);
  });

  it("rejects non-member assignees and foreign labels", async () => {
    const stranger = await addUserWithToken(t.ctx, `stranger-${placement}`);
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        title: "bad assignee",
        assignee_ids: [stranger.user.id],
      }),
    });
    expect(res.status).toBe(422);
  });

  it("writes referenced events on the mentioned issue", async () => {
    const target = await createIssue({ title: "Reference target" });
    const source = await createIssue({
      title: "Referencing",
      body: `this relates to #${target.number}`,
    });

    const timeline = await timelineOf(target.number);
    const referenced = timeline.items.find(
      (i: { type: string; event_type?: string }) =>
        i.type === "event" && i.event_type === "referenced",
    );
    expect(referenced.payload.by_issue).toBe(source.number);

    // Re-saving the same body must not duplicate the event.
    await t.app.request(`/api/projects/${slug}/issues/${source.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ body: `edited — still about #${target.number}` }),
    });
    const again = await timelineOf(target.number);
    const count = again.items.filter(
      (i: { type: string; event_type?: string }) =>
        i.type === "event" && i.event_type === "referenced",
    ).length;
    expect(count).toBe(1);
  });

  it("comments land on the timeline and reference from comments too", async () => {
    const target = await createIssue({ title: "Comment ref target" });
    const host = await createIssue({ title: "Comment host" });

    const comment = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${host.number}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ body: `ping #${target.number}` }),
        },
      ),
    );
    expect(comment.type).toBe("comment");

    const hostTimeline = await timelineOf(host.number);
    expect(
      hostTimeline.items.some(
        (i: { type: string; id: number }) =>
          i.type === "comment" && i.id === comment.id,
      ),
    ).toBe(true);

    const targetTimeline = await timelineOf(target.number);
    const ref = targetTimeline.items.find(
      (i: { type: string; event_type?: string }) =>
        i.type === "event" && i.event_type === "referenced",
    );
    expect(ref.payload.by_comment).toBe(comment.id);
  });

  it("fetches a single comment by id, scoped to its issue", async () => {
    const issue = await createIssue({ title: "Permalink host" });
    const other = await createIssue({ title: "Permalink other" });
    const comment = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ body: "anchor me" }),
        },
      ),
    );

    const res = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const fetched = await json(res);
    expect(fetched.id).toBe(comment.id);
    expect(fetched.body).toBe("anchor me");
    expect(fetched.author.login).toBeTruthy();

    // The wrong issue number must not leak another issue's comment.
    const cross = await t.app.request(
      `/api/projects/${slug}/issues/${other.number}/comments/${comment.id}`,
      { headers: { cookie } },
    );
    expect(cross.status).toBe(404);
  });

  it("edits and deletes comments with author/admin guard", async () => {
    const issue = await createIssue({ title: "Comment perms" });
    const comment = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ body: "original" }),
        },
      ),
    );

    const bob = await addUserWithToken(t.ctx, `commenter-${placement}`);
    await t.app.request(`/api/projects/${slug}/members/${bob.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "writer" }),
    });

    const forbidden = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify({ body: "hijacked" }),
      },
    );
    expect(forbidden.status).toBe(403);

    const edited = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ body: "edited" }),
        },
      ),
    );
    expect(edited.edited_at).not.toBeNull();

    const del = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(del.status).toBe(204);
  });

  it("filters and paginates the issue list", async () => {
    const filterSlug = `filter-${placement.replaceAll(/[^a-z]/g, "")}`;
    await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: filterSlug, name: "Filters" }),
    });
    const statuses = await json(
      await t.app.request(`/api/projects/${filterSlug}/statuses`, {
        headers: { cookie },
      }),
    );
    const done = statuses.find((s: { name: string }) => s.name === "Done");

    for (let i = 1; i <= 5; i++) {
      const res = await t.app.request(`/api/projects/${filterSlug}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          title: `Task ${i}`,
          body: i === 3 ? "the special one" : "",
          ...(i % 2 === 0 ? { status_id: done.id } : {}),
        }),
      });
      expect(res.status).toBe(201);
    }

    const open = await json(
      await t.app.request(`/api/projects/${filterSlug}/issues?category=open`, {
        headers: { cookie },
      }),
    );
    expect(open.items).toHaveLength(3);
    expect(open.items[0].body).toBeUndefined();

    const search = await json(
      await t.app.request(`/api/projects/${filterSlug}/issues?q=special`, {
        headers: { cookie },
      }),
    );
    expect(search.items).toHaveLength(1);
    expect(search.items[0].title).toBe("Task 3");

    const page1 = await json(
      await t.app.request(
        `/api/projects/${filterSlug}/issues?sort=number&order=asc&limit=2`,
        { headers: { cookie } },
      ),
    );
    expect(page1.items.map((i: { number: number }) => i.number)).toEqual([
      1, 2,
    ]);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await json(
      await t.app.request(
        `/api/projects/${filterSlug}/issues?sort=number&order=asc&limit=2&cursor=${page1.next_cursor}`,
        { headers: { cookie } },
      ),
    );
    expect(page2.items.map((i: { number: number }) => i.number)).toEqual([
      3, 4,
    ]);
  });

  it("counts open/closed issues, honoring the list filters", async () => {
    const countsSlug = `counts-${placement.replaceAll(/[^a-z]/g, "")}`;
    await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: countsSlug, name: "Counts" }),
    });
    const statuses = await json(
      await t.app.request(`/api/projects/${countsSlug}/statuses`, {
        headers: { cookie },
      }),
    );
    const done = statuses.find((s: { name: string }) => s.name === "Done");

    for (let i = 1; i <= 5; i++) {
      const res = await t.app.request(`/api/projects/${countsSlug}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          title: `Task ${i}`,
          body: i === 3 ? "the special one" : "",
          ...(i % 2 === 0 ? { status_id: done.id } : {}),
        }),
      });
      expect(res.status).toBe(201);
    }

    const all = await json(
      await t.app.request(`/api/projects/${countsSlug}/issues/counts`, {
        headers: { cookie },
      }),
    );
    expect(all).toEqual({ open: 3, closed: 2 });

    const searched = await json(
      await t.app.request(
        `/api/projects/${countsSlug}/issues/counts?q=special`,
        { headers: { cookie } },
      ),
    );
    expect(searched).toEqual({ open: 1, closed: 0 });

    // A filter that matches nothing yields zeros, not an error.
    const none = await json(
      await t.app.request(
        `/api/projects/${countsSlug}/issues/counts?assignee=999`,
        { headers: { cookie } },
      ),
    );
    expect(none).toEqual({ open: 0, closed: 0 });
  });

  it("pages the timeline in both directions", async () => {
    const issue = await createIssue({ title: "Long thread" });
    for (let i = 1; i <= 7; i++) {
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ body: `comment ${i}` }),
        },
      );
    }

    // Newest page: opened event + 7 comments = 8 items; last 3.
    const lastPage = await timelineOf(issue.number, "?last=1&limit=3");
    expect(lastPage.items).toHaveLength(3);
    expect(lastPage.items.at(-1).body).toBe("comment 7");
    expect(lastPage.prev_cursor).not.toBeNull();
    expect(lastPage.total_count).toBe(8);

    // Walk backward.
    const older = await timelineOf(
      issue.number,
      `?before=${lastPage.prev_cursor}&limit=3`,
    );
    expect(older.items.at(-1).body).toBe("comment 4");
    expect(older.total_count).toBe(8);

    // Walk forward from the older page's end — must reconnect seamlessly.
    const forward = await timelineOf(
      issue.number,
      `?after=${older.next_cursor}&limit=10`,
    );
    expect(forward.items[0].body).toBe("comment 5");
    expect(forward.items).toHaveLength(3);
    expect(forward.total_count).toBe(8);

    // Beginning is reachable and flagged.
    const start = await timelineOf(issue.number, "?limit=4");
    expect(start.prev_cursor).toBeNull();
    expect(start.items[0].event_type).toBe("opened");
    expect(start.total_count).toBe(8);
  });

  it("total_count follows the types filter, not the cursor window", async () => {
    const issue = await createIssue({ title: "Counted thread" });
    for (let i = 1; i <= 3; i++) {
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ body: `counted ${i}` }),
        },
      );
    }

    const commentsOnly = await timelineOf(
      issue.number,
      "?types=comment&limit=1",
    );
    expect(commentsOnly.items).toHaveLength(1);
    expect(commentsOnly.total_count).toBe(3);

    await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: "counted 4" }),
      },
    );
    const again = await timelineOf(issue.number, "?types=comment&limit=1");
    expect(again.total_count).toBe(4);
  });

  it("readers cannot write issues or comments", async () => {
    const reader = await addUserWithToken(t.ctx, `reader-${placement}`);
    await t.app.request(`/api/projects/${slug}/members/${reader.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "reader" }),
    });
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", ...reader.headers },
      body: JSON.stringify({ title: "not allowed" }),
    });
    expect(res.status).toBe(403);
  });
});
