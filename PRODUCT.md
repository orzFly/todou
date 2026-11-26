# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The web client's primary users are one or two people directing a group of AI agents. The agents do
the work through the `todou` CLI: they take cards, ask questions, push specs, comment, and wait on
watches. The people answer those questions, review and approve specs, read the inbox, triage new
cards, and move cards across the board, all in the web client.

Agents have accounts of their own, but they reach todou through the CLI and the REST API, not the
web client.

## Product Purpose

todou is a self-hostable issue tracker built for humans and AI agents working together: projects, a
kanban board, issues, labels, markdown comments and attachments. The web client is where the people
directing the agents respond to them, so that work waiting on a person does not stay waiting.

## Positioning

Agents are first-class accounts, not an integration bolted on:

- Machine accounts authenticate with personal access tokens and can do everything a member can.
- Writes made from inside an agent session carry the harness, model and session, and the timeline
  shows them as provenance badges.
- Agents post structured multiple-choice questions on a card; a person answers them in a couple of
  clicks, and the CLI blocks until the answers arrive.
- Specs are versioned markdown document sets on a card, reviewed with inline annotations and
  approve/request-changes verdicts.
- Watches are cursor-based, over SSE, for one card or a whole project: an agent waits on a card and
  wakes when something happens, across restarts.

This repository is developed by agents coordinated through todou itself.

## Operating Context

- Responding happens wherever the person is. On a phone, answering questions, approving or sending
  back a spec, reading the inbox and issues, and changing status have to be comfortable. Deep work
  (dragging on the board, reviewing long diffs, settings) is desktop-first; on a phone it has to
  work, not to be as comfortable.
- Statuses are configured per project. This repository's tracker runs Backlog → Todo → Next →
  In Progress → Ready to Ship → Shipped → Done, with Invalid closing a card without doing it; agents
  take a card as far as Ready to Ship, and only a person marks it Done.
- Addresses travel between surfaces: an issue address copied from the web client works as an
  argument to the CLI, and a transferred card keeps its old links working.
- One process serves the web client and the API. Single-user mode with embedded PGlite needs no
  setup; PostgreSQL is there when a deployment needs it.
- The web client has no marketing or landing pages; every page is a working screen.

## Capabilities and Constraints

- Web pages: sign-in; projects; per project the issue list, board, insights, search, new issue,
  issue detail and spec review, and project settings (members, statuses, labels, references); the
  inbox; user pages; personal settings (profile, appearance, inbox, agents, personal tokens); and the
  pages that authorize a CLI login and grant an agent access.
- Interface text is English. Content on cards is not limited to English: this repository's own
  cards are mostly Chinese, and search matches Chinese, Japanese and Korean as substrings.
- Interface text and navigation follow AGENTS.md, "Interface text says what the screen cannot" and
  "Navigation is links".
- The design system is `@orz/ui`: its components, theme store and stylesheet. Component and visual
  rules live in its own skill and docs, which AGENTS.md ("UI components") points to. There is no
  DESIGN.md on purpose; a copy here would go stale.
- The repository is public. Everything in it, fixtures and mockups included, follows AGENTS.md
  "Sanitization": placeholders such as `todou.example`, `alice` and `claude-agent` stand in for real
  hostnames, people and accounts.

## Brand Commitments

- The name is lowercase **todou**. It reads as "To-Do" and sounds like 土豆 (tǔdòu, potato); the mark
  is 🥔. The naming story is in `docs/codename.md`.

## Evidence on Hand

- The dogfooding: this repository is built by agents working through todou.
- The repository holds no customer names, testimonials, usage figures or benchmarks. Future work
  must not invent them.

## Product Principles

1. **Unblocking an agent comes first.** Answering a question, reviewing a spec and reading the inbox
   are the jobs the web client exists for, and they get the shortest path.
2. **Respond anywhere, work deeply at a desk.** The responding jobs are judged on a phone as well as
   a desktop; the heavy ones are judged at desktop widths and only have to work on a phone.
3. **Every write shows who made it.** An agent's comment, question or verdict is never presented as
   a person's.
4. **Addresses last.** Destinations are real links, and an address the web client shows keeps
   working in the CLI and after a card moves.

## Accessibility & Inclusion

No accessibility standard is committed to yet. Audits judge contrast, focus and keyboard reach by
common sense. Whether to adopt a standard such as WCAG 2.2 AA is open on T-804.
