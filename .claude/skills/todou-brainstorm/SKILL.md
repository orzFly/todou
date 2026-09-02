---
name: todou-brainstorm
description: Interactively brainstorm a design/approach with the user on a todou issue — turn ideas into fully formed designs through natural collaborative dialogue, with the whole exchange recorded on the tracker and the user answering from the web UI. Use before starting any design-heavy card.
disable-model-invocation: true
---

# Brainstorming ideas into designs (todou edition)

Turn an idea into a fully formed design by talking with the user on the todou issue. Every question,
answer and revision stays in the timeline, so whoever implements the design can replay the decisions.
Questions follow the "Asking the user questions" section of `/todou-cli`; the review gate follows its
"Spec documents" section.

<HARD-GATE>
Write no code, scaffold nothing and invoke no implementation skill until the user has approved the
design at the review gate. This holds for cards that look too simple to need a design. Unexamined
assumptions cost the most on simple cards, so the design may be a few sentences, and it is still
pushed as a spec and approved.
</HARD-GATE>

## Steps

1. Explore the project context: files, docs, recent commits, `todou issue view N` for the card and
   its discussion. Move the card to In Progress.
2. Ask clarifying questions on the issue: purpose, constraints, success criteria. Build a mockup or
   demo when a question is easier to answer from a picture (see Visual material).
3. Write the design to a scratch directory made with `mktemp -d`. The approaches you weighed and your
   recommendation go into the document, never into a comment.
4. Self-review the documents, then push with `todou spec push <n> <dir> -p <proj> --message
   "brainstorm v1" --wait` and act on the outcome (see Review gate).
5. After `approved`, invoke `/todou-plan`.

## Working through the idea

- Check the scope before refining details. A request that describes several independent subsystems
  is decomposed first: each part gets its own card and its own design, plan and implementation. Then
  brainstorm the first part.
- Refine in rounds. Prefer multiple-choice questions whose options are already researched: read the
  code, data and prior art first, and do not leave that homework to the user.
- Needs that surface mid-discussion and fall outside this card go to `todou issue create` at once.
- Weigh two or three approaches before settling. The comparison, the rejected options and the reasons
  belong in the spec. Put a choice on the card only when it is the user's to make and fits a
  multiple-choice question.
- Follow the existing structure and patterns. Where existing code has problems that affect the work,
  include targeted improvements in the design. When you notice a refactor that would help but is not
  required, ask the user with a native question; the decision is theirs.
- Design for isolation: units with one clear purpose, communicating through defined interfaces,
  understandable without reading their internals. Smaller units are also easier for you to hold in
  context and to edit reliably.
- Write the spec as soon as you understand what you are building. Do not summarize the design in a
  comment first and ask whether to write it up: the user would read the same text twice, and a comment
  has neither inline annotations nor a diff against the previous version.
- User answers may overturn your premises. Reversals are normal; update the design.

## The documents

- `proposal.md` holds the user's original requirements that have no tracker trace: requirements from
  the terminal or other outside channels, quoted verbatim without commentary. Card body, comments and
  question answers are referenced, never copied. Keep the file current: new information goes in,
  corrections replace the relevant sentences, and the meaning of review annotations is recorded here.
- `brainstorm.md` is the design the user reviews: approaches weighed, option chosen, options rejected
  and why. Scale each section to its complexity. Cover architecture, components, data flow, error
  handling and testing.

Self-review before pushing: remove placeholders and vague requirements, resolve contradictions
between sections, confirm the scope fits one implementation plan, and rewrite any requirement that can
be read two ways.

## Review gate

`spec push … --wait` ends with one of these lines:

- `approved` → step 5.
- `changes requested` → `todou spec comments <n> --unresolved`, revise, update `proposal.md`,
  `todou spec resolve <n> <ids…>`, push again with `--if-version <v> --wait`.
- `feedback` → the user wrote in plain comments. Treat it as review feedback, revise, and point them
  at the review controls in your next comment.

A killed wait is re-entered with `todou spec wait <n> --since <cursor>`.

## Hand-off

Invoke `/todou-plan`. Whether the same agent continues past the plan is decided by the orchestrator,
so leave everything you produced on the tracker: mockups attached, conclusions in the spec.

## Visual material

When a question is easier to answer from a picture (mockups, layout comparisons, architecture
diagrams, variant matrices), build a self-contained demo page, attach the single HTML file to the
issue with `todou attach`, and explain it in a comment. Attach screenshots only when the environment
has a browser you know works. Decide per question: what the UI looks like calls for images;
requirements, trade-offs and scope call for text.
