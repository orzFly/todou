---
name: todou-brainstorm
description: Interactively brainstorm a design/approach with the user on a todou issue — turn ideas into fully formed designs through natural collaborative dialogue, with the whole exchange recorded on the tracker and the user answering from the web UI. Use before starting any design-heavy card.
disable-model-invocation: true
---

# Brainstorming Ideas Into Designs (todou edition)

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.
The one essential difference from plain /brainstorm: **the dialogue lives on a todou issue** — every
question, answer, and proposal revision stays in the timeline, so anyone later (including the agent
implementing it, likely you) can replay the decisions.

Start by understanding the current project context, then ask questions to refine the idea. Once you
understand what you're building, **write the design as a spec and let the review gate be the approval
step** — the design does not get narrated into a comment first.

**All questions to the user follow the "Asking the user questions" section of `/todou-cli`**
(numbered-option comments + `issue watch` for replies) — not repeated here.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any
implementation action until the user has approved the spec at the review gate.
This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change —
all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design
can be short (a few sentences for truly simple projects), but you MUST push it as a spec and get it
approved.

## Checklist

You MUST create a task for each of these items and complete them in order:

1. **Explore project context** — check files, docs, recent commits; `todou issue view N` for the card
   and its prior discussion; move the card to In Progress
2. **Use visuals when a question benefits from them** — build the mockup/demo directly, no permission
   needed (see Visual Material below)
3. **Ask clarifying questions** — via issue comments (per /todou-cli); understand purpose/constraints/success criteria
4. **Write the design doc** — to a temp directory; the 2-3 approaches, their trade-offs, and your
   recommendation go *in it*, not into a comment
5. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
6. **User reviews the written spec** — push it and wait for the verdict (see Review Gate)
7. **Transition to implementation** — invoke the todou-plan skill (until it exists, file-based-plan)

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent
  subsystems, flag this immediately. Don't spend questions refining details of a project that needs
  decomposition first.
- If the project is too large for a single spec, help the user decompose: what are the independent
  pieces, how do they relate, what order? Each sub-project gets its own card and its own
  spec → plan → implementation cycle. Then brainstorm the first one normally.
- For appropriately-scoped projects, refine round by round (one comment may carry 2-3 tightly related
  small questions to cut round-trips; see /todou-cli)
- Prefer multiple choice questions when possible, but open-ended is fine too
- **Out-of-scope needs that surface mid-discussion** (users often say "file that separately") go
  straight to `todou issue create` — an issue ref in the body auto-links back — then return to the main thread
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Weigh 2-3 different approaches with trade-offs before settling on one
- Every option should arrive already researched — read the code/data/prior art first and make the
  options concrete; don't outsource the homework to the user
- **The comparison belongs in the spec**, together with the rejected options and why. Put an approach
  on the card only when the choice is genuinely the user's and answerable as multiple-choice — then it
  is a question, not an essay.

**Writing the design:**

- Once you believe you understand what you're building, write the spec. **Do not narrate the design
  into a comment first and ask "does this look right, shall I write it up?"** — that round makes the
  user read the same prose twice, and a comment has neither inline annotations nor a diff against the
  previous version. The review gate is the approval step; one document, one place to annotate, one verdict.
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Cover: architecture, components, data flow, error handling, testing
- Revisions land as new spec versions, so the user can diff v2 against v1 instead of reconstructing the
  change out of a comment thread
- Be ready to go back and clarify; user answers may overturn your premises — reversals are normal, don't dig in

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through
  well-defined interfaces, and can be understood and tested independently
- For each unit: what does it do, how do you use it, what does it depend on?
- Can someone understand a unit without reading its internals? Can you change the internals without
  breaking consumers? If not, the boundaries need work.
- Smaller, well-bounded units are also easier for you — you reason better about code you can hold in
  context at once, and your edits are more reliable when files are focused.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work, include targeted improvements in the design —
  the way a good developer improves code they're working in.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

**Documentation:**

- Write the user's original requirements to `<tmpdir>/proposal.md` — **excluding anything already
  recorded on the tracker**: the card body, comments, and question answers live in the timeline and
  are referenced (issue refs — spelled as /todou-cli says, permalinks), never copied. Record verbatim, transcript-style and without
  judgment, only what has no tracker trace (requirements stated in the terminal/chat or other
  outside channels).
  - **Keep proposal.md up to date.** New information from the user during planning or execution goes in.
    Corrections modify the relevant sections directly — never append conflicting or wishy-washy entries.
    This counts as an explicitly requested modification of the recorded requirements, so it is allowed.
  - The meaning of any review annotations the user leaves gets recorded into proposal.md as well.
- Write the design (spec) to `<tmpdir>/brainstorm.md` — this is the document the user reviews, so it
  carries the full reasoning: approaches weighed, option chosen, options rejected and why
- Use the elements-of-style:writing-clearly-and-concisely skill if available
- **Do not commit these documents to git.** Push them to the issue as a spec set:
  `todou spec push <n> <tmpdir> -p <proj> --message "brainstorm v1"` — the tracker carries the design
  (see the spec section of /todou-cli).

**Spec Self-Review:**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be read two ways? Pick one and make it explicit.

Fix issues inline. No need to re-review — just fix and move on.

**Review Gate:**

After the self-review passes, push the spec set and post a short pointer comment summarizing what
changed, then wait for the review verdict:

```bash
todou spec push <n> <tmpdir> -p <proj> --message "brainstorm v2"
cursor=$(todou watch -p <proj> --poll --print-cursor)
todou issue watch <n> -p <proj> --since "$cursor" --debounce 60 --forever
```

The watch is unfiltered — plain comments wake you too, and so do sibling agents on the same machine
account (the self-filter is per agent session). Judge every wake-up with `todou spec status <n>`,
never by reading the event stream (full protocol: /todou-cli, Spec documents):

- **approve** → proceed.
- **request-changes** or unresolved annotations → `todou spec comments <n> --unresolved`, revise
  the documents, sync proposal.md, `todou spec resolve` the addressed ones, push the next version,
  wait again; repeat until approved.
- User replied in plain comments instead of a verdict → treat it as feedback, revise, and point them
  at the review controls in your next comment.
- None of the above → not yours; resume the wait silently with the cursor the watch printed (only a
  wait killed from outside needs restarting by hand). Never poll `spec status` in place of the
  blocking watch.

**Implementation:**

- Invoke the todou-plan skill to create a detailed implementation plan.
- Do NOT invoke any other skill. That is the only next step.
- After approval, implementation is normally continued by **the same agent in the same worktree** —
  you are now the person who understands this design best.

## Key Principles

- **Focused comment rounds** — 2-3 tightly related small questions per comment: no barrage, no dragging
- **Multiple choice preferred** — every question ships with a recommendation + reasoning, so the user
  can advance the design with a two-character reply ("a1, b2")
- **YAGNI ruthlessly** — remove unnecessary features from all designs
- **Explore alternatives** — always 2-3 approaches before settling; record the rejected options and why
  in the spec — they are as valuable as the chosen one
- **Long prose lives in the spec** — comments carry questions, pointers, and verdicts. Anything the
  user might want to annotate, diff, or re-read belongs in a spec version, not in the timeline.
- **Be flexible** — go back and clarify when something doesn't make sense

## Visual Material

When a question lands better seen than read (mockups, layout comparisons, architecture diagrams,
variant matrices), build a self-contained demo page and attach **the single-file HTML** to the issue
with `todou attach`, plus an explanatory comment. Only render and attach screenshots when the
environment has a browser you already know works.
Decide per question: visual content (what the UI looks like) → images; textual content (requirements,
trade-offs, scope) → a text comment. A question about a UI topic is not automatically a visual question.
