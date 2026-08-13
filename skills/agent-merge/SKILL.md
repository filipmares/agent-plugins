---
name: agent-merge
description: "Use when an agent is working a pull-request review round unattended — agent merge, a coding agent resolving review threads, an automated PR-feedback loop — and needs to decide which review suggestions to implement, which to decline as out of scope, and how to record each decision so the declined ones stay queryable. Also use when auditing those recorded decisions across a repo's PRs."
license: MIT
metadata:
  author: filipmares
  version: '1.0.0'
---

# Agent Merge: Scope Discipline

**Applies to unattended runs** — agent merge, or a coding agent working a review round
without a human reading each commit. When a human reviews every diff before it lands,
they set the scope and this skill does not apply.

**A review comment is an input, not a mandate. Valid but out-of-scope feedback is
handled by explaining and resolving it, not by changing code.**

Deciding *whether* a suggestion belongs in this PR is part of handling it. "The
reviewer asked for it" is not a scope justification, and neither is "it was a small
change". This needs saying because a thread only counts as handled once a reply and a
resolve both succeed, so the cheapest route to "ready" is always to make the change.
Nothing in the loop compares the accumulated diff against what the PR set out to do,
and no single tick looks unreasonable. The drift is the sum.

## Decide in this order

1. **Does it still apply?** If not → `inapplicable` (§When the feedback no longer applies).
2. **Does it name a defect this PR causes, a violation of the repository's own written
   rules, or something the PR already committed to?** → `fixed` (§Change the code when).
3. **Is it a genuine scope or intent question?** → escalate (§Stop and ask).
4. **Anything else** → `deferred` (§Otherwise).

Applicability comes first on purpose: a comment written against a superseded commit can
describe a defect convincingly, and checking scope before staleness is how a run ends up
"fixing" something a later push already fixed.

Review state is not an input to this test. A `CHANGES_REQUESTED` review does not make its
suggestions in scope, and an approval does not make a defect skippable — a verdict is the
reviewer's judgement of the PR as a whole, not of which comment belongs in it.

The *form* of a suggestion is not an input either. A committable `suggestion` block — the
kind GitHub renders with an Apply button — is a request like any other: one-click
applicability changes what the fix costs, not whether it belongs here. Route it through
the order above, and when the answer is out of scope, leave it unapplied and mark it
`deferred` — declining a patch someone has already written feels wasteful in a way that
declining prose does not, and that feeling is not evidence of scope. An in-scope one is
still `fixed`, applied as written or replaced with a better fix.

## Change the code when

- The feedback identifies a **defect this PR causes** — correctness, security,
  accessibility, data loss, or material performance. Judge by **causality, not by line
  ownership**: an omission, a broken consumer, or a missing config change is caused by
  this PR even when it surfaces in a file the PR never touched.
- It is an **applicable violation of the repository's own agent instruction files** —
  whatever this repo uses to state its conventions — in this PR's own changes.
- **The linked issue or design document already commits to it.** When the PR has neither,
  and only then, its description takes that role. A description cannot override an issue
  or design document that is silent on the point — it is editable by the run, so letting
  it extend scope would make the contract self-amending; it governs only where there is
  otherwise nothing.

Then mark the thread `fixed` and resolve it, the same as the branches below.

If you think a point is valid and in scope but disagree with the approach, an
alternative fix is still `fixed`. Replying with no change at all is not yours to settle:
escalate it (§Stop and ask) rather than closing the thread on your own judgement.

## When the feedback no longer applies

Stale review is ordinary on a PR that has been through revisions: a comment written
against a superseded commit, one asking for something a later push already did, or one
resting on a reading of the code that is simply wrong. Say which of those it is, mark
the thread `inapplicable`, and resolve.

Keep this distinct from `deferred`. Both close a thread without changing code, but only
`deferred` names a suggestion someone may still want. An obsolete comment filed there is
noise in a queue whose entire value is that everything in it is real.

## Otherwise, do not change the code — reply, mark, resolve

A valid adjacent improvement, a refactor of code this PR only moved, tests for
pre-existing behaviour, a rename, a new dependency, "while you're here" — none of these
is yours to land here. Scope and merit are independent axes, so say plainly that the
suggestion is good and belongs elsewhere; do not manufacture a technical objection to
justify not doing it.

Reply, mark the thread `deferred`, resolve it, and carry on. **Do not stop to ask.**
This loop is unattended by design, and an escalation per adjacent suggestion would
stall it on exactly the PRs that collect the most feedback.

**Never file an issue on your own initiative.** One issue per deferred thread turns
casual review advice into committed backlog debt, and a follow-up ticket normally
records something the team *agreed* to do — agreement a reviewer's suggestion does not by
itself establish. The one exception is a reviewer asking for tracking in the thread: file
it per the repository's issue conventions, then mark `tracked` with `issue=` naming it. A
reviewer who filed the issue themselves settles it the same way — mark `tracked` with
their number. `tracked` without an `issue=` is malformed.

Nothing is lost by not asking: the breadcrumb below makes every deferred thread
queryable, so the backlog decision happens later, in one pass, by a human seeing all of
them at once — rather than interrupting the run once per suggestion.

## Stop and ask

On a **scope** question: when intent is genuinely ambiguous, two reviewers want
contradictory things, or the fix has outgrown the linked issue. These are blockers, not
dispositions — an out-of-scope suggestion is never one of them. Escalating is cheaper
than guessing, and much cheaper than a merged PR nobody meant to approve.

This section narrows nothing else. Whatever escalation triggers the surrounding merge
loop already has — an unresolvable conflict, a CI failure you cannot fix — still stand on
their own.

## Leave a breadcrumb

Every reply that **resolves** a thread carries one hidden marker on its own line, so
dispositions stay countable later without re-reading each PR by hand:

```
<!-- agent-merge disposition=<fixed|deferred|tracked|inapplicable> [issue=<number>] -->
```

If the repository also requires a bot-authorship footer on machine-written comments, the
marker sits immediately **above** it — that footer stays last, because its whole job is
to identify the comment as machine-authored. The census matches the marker anywhere in
the body, so the ordering costs it nothing.

### Dispositions

`fixed` — you changed the code. `deferred` — valid, but outside this PR; no code change.
`tracked` — a reviewer asked for tracking and you filed one; include `issue=`.
`inapplicable` — the comment was factually wrong, obsolete, or the code already does
what it asks.

A reply that leaves the thread **open** carries no marker: an escalation is a question,
not a disposition, and there is deliberately no marker meaning "still deciding". The
thread gets one when it closes.

`deferred` is the one that earns its keep: `agent-merge-stats.mjs --deferred` lists
every suggestion the rule turned away, with links, so they can be triaged in bulk
whenever someone has the appetite. The marker renders as nothing, so the prose above it
still has to state the decision in plain language; this is for counting, not for
communicating.

### Not dispositions

Those four are the entire vocabulary. Copy one verbatim; do not reach for the word that
describes what you did. `DISPOSITIONS` in `scripts/agent-merge-stats.mjs` is the same
four and its `parseMarker` reports anything else as malformed rather than bucketing it,
so an invented token is not a fifth disposition — it is a thread that never gets counted
at all. This is not hypothetical: a census over one large repository read 991
dispositioned threads across 119 PRs and found 32 markers outside the set, every one of
them a synonym an agent preferred to the token it stands for. Knowing the right token is
not enough to stay inside the set — a single PR in that census carried 13 correct `fixed`
markers and 4 invented ones in the same run. Copy from the list; do not paraphrase the
meaning.

| Written instead | Means |
| --- | --- |
| `accepted`, `addressed`, `implemented` | `fixed` |
| `declined`, `rejected`, `wontfix`, `acknowledged` | nothing on its own — a thread closed with no code change is `deferred` or `inapplicable`, and the order above says which |

The right column corrects a census a human is reading; it is not a translation the script
performs. `agent-merge-stats.mjs --malformed` prints the token, the link, and the
disposition it should have carried, and counts it as neither — aliasing an invented token
into a real bucket would erase the only evidence that the vocabulary is drifting.

## Feedback that has no thread

Top-level PR comments and review bodies carry the same kind of asks, and GitHub gives
them no resolve state. Classify them exactly as above and act the same way — but there
is nothing to mark or resolve, so they take no marker and never appear in the census.
Say in your run summary what you did with them.

## For reviewers

A suggestion is classified on its merits. `Non-blocking:` tells the run you already
believe it is out of scope, which is worth writing — it is corroboration, not an
instruction, and it never suppresses a real defect. Saying outright that you want
something tracked, or filing the issue yourself, is what actually settles the
disposition without the author being asked.

## Auditing the decisions

`scripts/agent-merge-stats.mjs` reads the breadcrumbs back, so the scope rule can be
evaluated on evidence rather than impression. Requires `node` (>= 18) and an
authenticated `gh`; it is read-only, and with no `--repo` it censuses whichever
repository the current directory belongs to.

```sh
node scripts/agent-merge-stats.mjs                   # counts for the current repo
node scripts/agent-merge-stats.mjs --deferred        # what the rule turned away, with links
node scripts/agent-merge-stats.mjs --malformed       # markers counted as nothing, and their correction
node scripts/agent-merge-stats.mjs --by-pr           # per-PR breakdown
node scripts/agent-merge-stats.mjs --json            # machine-readable
node scripts/agent-merge-stats.mjs --repo owner/name # somewhere else
```

What the numbers do and do not show: a thread marked `fixed` is counted as fixed.
Whether it *should* have been is not visible here and still needs a sampled read of the
diff. This finds the threads; it does not judge them.

## Adopting this in a repository

The skill is self-contained, but two things are worth wiring up locally:

1. **State the one-sentence rule wherever the repo's always-loaded agent instructions
   live.** A skill that has to be chosen before it is read cannot govern a decision the
   run makes before choosing it; the sentence in the always-loaded file is the trigger,
   and this file is the detail. Keep the two in sync.
2. **Give the census a short alias** — an npm/pnpm script, a Makefile target — so the
   `--deferred` queue is cheap enough to actually get triaged.

Do not re-state CI triage, conflict resolution, or merge mechanics here. A second
authority for the same decision is how an agent ends up picking the wrong one, and a
cached fact about branch protection or a non-blocking check goes stale silently.
