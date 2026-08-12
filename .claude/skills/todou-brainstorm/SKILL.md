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
understand what you're building, present the design and get user approval.

**All questions to the user follow the "Asking the user questions" section of `/todou-cli`**
(numbered-option comments + `issue watch` for replies) — not repeated here.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any
implementation action until you have presented a design and the user has approved it.
This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change —
all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design
can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

You MUST create a task for each of these items and complete them in order:

1. **Explore project context** — check files, docs, recent commits; `todou issue view N` for the card
   and its prior discussion; move the card to In Progress
2. **Use visuals when a question benefits from them** — build the mockup/demo directly, no permission
   needed (see Visual Material below)
3. **Ask clarifying questions** — via issue comments (per /todou-cli); understand purpose/constraints/success criteria
4. **Propose 2-3 approaches** — with trade-offs and your recommendation
5. **Present design** — in sections scaled to their complexity, get the user's confirmation
6. **Write design doc** — to a temp directory, and attach it to the issue
7. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
8. **User reviews written spec** — on the issue (see Review Gate)
9. **Transition to implementation** — invoke the todou-plan skill (until it exists, file-based-plan)

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
  straight to `todou issue create` — a `#N` reference in the body auto-links back — then return to the main thread
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally, leading with your recommended option and why
- Every option should arrive already researched — read the code/data/prior art first and make the
  options concrete; don't outsource the homework to the user

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask the user to confirm section by section (one comment round can cover several sections)
- Cover: architecture, components, data flow, error handling, testing
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

- Write the user's original requirements to `<tmpdir>/proposal.md` — everything the user told you,
  plus the questions you asked and the user's answers, recorded verbatim like a transcript, without
  adding your own judgment.
  - When recording a question and its options, reproduce them exactly as they appeared in your issue
    comment — same question text, same option labels and descriptions. Do not summarize or omit details.
  - **Keep proposal.md up to date.** New information from the user during planning or execution goes in.
    Corrections modify the relevant sections directly — never append conflicting or wishy-washy entries.
    This counts as an explicitly requested modification of the recorded requirements, so it is allowed.
  - The meaning of any review annotations the user leaves gets recorded into proposal.md as well.
- Write the validated design (spec) to `<tmpdir>/brainstorm.md`
- Use the elements-of-style:writing-clearly-and-concisely skill if available
- **Do not commit these documents to git.** Attach both files to the issue with `todou attach` —
  the tracker carries the design. (Once spec support lands in todou, switch to pushing them as
  proper spec documents.)

**Spec Self-Review:**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be read two ways? Pick one and make it explicit.

Fix issues inline. No need to re-review — just fix and move on.

**Review Gate:**

After the self-review passes, post the final proposal as one complete comment on the issue (versioned,
e.g. "v2, supersedes the previous"), attach brainstorm.md / proposal.md, then wait for the review:

```bash
todou issue watch <n> -p <proj> --since <cursor> --timeout 43200 --json
```

- User leaves comments/annotations → revise the documents, sync proposal.md, re-attach and post the
  new version, wait again; repeat until there are no new comments.
- User approves (often just "looks good / go ahead") → proceed.
- User acknowledges without clear approval → state that the spec review is complete and ask whether
  to proceed to implementation planning.

**Implementation:**

- Invoke the todou-plan skill to create a detailed implementation plan (until it exists, file-based-plan).
- Do NOT invoke any other skill. That is the only next step.
- After approval, implementation is normally continued by **the same agent in the same worktree** —
  you are now the person who understands this design best.

## Key Principles

- **Focused comment rounds** — 2-3 tightly related small questions per comment: no barrage, no dragging
- **Multiple choice preferred** — every question ships with a recommendation + reasoning, so the user
  can advance the design with a two-character reply ("a1, b2")
- **YAGNI ruthlessly** — remove unnecessary features from all designs
- **Explore alternatives** — always 2-3 approaches before settling; record the rejected options and why —
  they are as valuable as the chosen one
- **Incremental validation** — present design, get approval before moving on
- **Be flexible** — go back and clarify when something doesn't make sense

## Visual Material

When a question lands better seen than read (mockups, layout comparisons, architecture diagrams,
variant matrices), build a self-contained demo page and attach **the single-file HTML** to the issue
with `todou attach`, plus an explanatory comment. Only render and attach screenshots when the
environment has a browser you already know works.
Decide per question: visual content (what the UI looks like) → images; textual content (requirements,
trade-offs, scope) → a text comment. A question about a UI topic is not automatically a visual question.
