---
name: todou-brainstorm
description: Interactively brainstorm a design/approach with the user on a todou issue — turn ideas into fully formed designs through natural collaborative dialogue, with the whole exchange recorded on the tracker and the user answering from the web UI. Use before starting any design-heavy card.
disable-model-invocation: true
---

# Brainstorming ideas into designs (todou edition)

Turn an idea into a fully formed design by talking with the user on the todou issue. Every question,
answer and revision stays in the timeline, so whoever implements the design can replay the decisions.
Questions follow the "Asking the user questions" section of `/todou-cli`; the review gate, and what a
spec document may and may not contain, follow its "Spec documents" section.

<HARD-GATE>
Write no code, scaffold nothing and invoke no implementation skill until the user has approved the
design at the review gate. This holds for cards that look too simple to need a design. Unexamined
assumptions cost the most on simple cards, so the design may be a few sentences, and it is still
pushed as a spec and approved.
</HARD-GATE>

## Steps

1. Move the card to In Progress, then run `todou agent can-i-follow` and do what it says. Explore the
   project context: files, docs, recent commits, `todou issue view N` for the card and its discussion.
2. Ask clarifying questions on the issue: purpose, constraints, success criteria. Build a mockup or
   demo when a question is easier to answer from a picture (see Visual material).
3. Write the design to a scratch directory made with `mktemp -d`. The approaches you weighed and your
   recommendation go into the document, never into a comment.
4. Self-review the documents, then push with `todou spec push <n> <dir> -p <proj> --message
   "brainstorm v1" --wait` and act on the outcome.
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
- Write the spec as soon as you understand what you are building. Do not summarize the design in a
  comment first and ask whether to write it up: the user would read the same text twice, and a comment
  has neither inline annotations nor a diff against the previous version.
- User answers may overturn your premises. Reversals are normal; update the design.

## The documents

- `proposal.md` holds the user's original requirements that have no tracker trace, kept current as
  `/todou-cli` describes.
- `brainstorm.md` is the design the user reviews: approaches weighed, option chosen, options rejected
  and why. Scale each section to its complexity. Cover architecture, components, data flow, error
  handling and testing.

Self-review before pushing: remove placeholders and vague requirements, resolve contradictions
between sections, confirm the scope fits one implementation plan, and rewrite any requirement that can
be read two ways.

## Hand-off

Invoke `/todou-plan`. Whether the same agent continues past the plan is decided by the orchestrator,
so leave everything you produced on the tracker: mockups attached, conclusions in the spec.

## Visual material

When a question is easier to answer from a picture (mockups, layout comparisons, architecture
diagrams, variant matrices), build a self-contained demo page, attach the single HTML file to the
issue with `todou attach`, and explain it in a comment. Attach screenshots only when the environment
has a browser you know works. Decide per question: what the UI looks like calls for images;
requirements, trade-offs and scope call for text.
