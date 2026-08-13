#!/usr/bin/env node

/**
 * Counts how agent-merge dispositioned review threads, across every PR in a repo.
 *
 * Unattended runs end each review-thread reply with a hidden marker
 * (this skill's `SKILL.md` §Leave a breadcrumb):
 *
 *   <!-- agent-merge disposition=tracked issue=1234 -->
 *
 * This reads them back so the scope rule can be evaluated on evidence rather than
 * impression. Without it, auditing means opening each PR and reading every thread,
 * which nobody sustains.
 *
 * Reads `repos/{owner}/{repo}/pulls/comments`, which returns every review comment in
 * the repo with its raw body, paginated. Deliberately not the GraphQL `reviewThreads`
 * walk: that is one request per PR and exhausts the GraphQL rate limit well before it
 * finishes a repo of this size.
 *
 * Read-only. It issues GET requests and writes nothing, so there is no `--check` mode
 * to pair with it.
 *
 * What the numbers do and do not show: a thread marked `fixed` is counted as fixed.
 * Whether it *should* have been is not visible here and still needs a sampled read of
 * the diff. This finds the threads; it does not judge them.
 *
 * Repo-agnostic: with no `--repo`, it asks `gh` which repository the current directory
 * belongs to. Nothing else in this file knows or assumes a particular repository.
 *
 * Usage:
 *   node agent-merge-stats.mjs                      count across the current repo
 *   node agent-merge-stats.mjs --deferred           list what the rule turned away
 *   node agent-merge-stats.mjs --malformed          list markers counted as nothing
 *   node agent-merge-stats.mjs --repo owner/name    another repo
 *   node agent-merge-stats.mjs --json               machine-readable output
 *   node agent-merge-stats.mjs --by-pr              break the counts down per PR
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const log = (msg) => process.stdout.write(`${msg}\n`);
const logError = (msg) => process.stderr.write(`[agent-merge-stats] ${msg}\n`);

/** Dispositions this skill's SKILL.md defines, in the order they are reported. */
export const DISPOSITIONS = ['fixed', 'deferred', 'tracked', 'inapplicable'];

/**
 * Tokens the census has actually caught outside {@link DISPOSITIONS}, and the
 * disposition each one meant where that is unambiguous.
 *
 * Every entry is observed in real censuses, none anticipated: `accepted`, `addressed`,
 * `implemented`, `declined`, `rejected`, `wontfix`, `acknowledged`. Run `--malformed`
 * to re-derive the list for your own repo, with a comment URL for each.
 *
 * This is a reporting aid, never a bucketing rule: an off-vocabulary marker stays
 * uncounted, and the correction is printed so a human can see both the drift and what it
 * should have said. Aliasing them into the four buckets would erase the only evidence
 * that the emitting side is inventing vocabulary.
 * Pinned against this skill's SKILL.md `### Not dispositions` table in the test suite.
 */
export const OFF_VOCABULARY = new Map([
  ['accepted', 'fixed'],
  ['addressed', 'fixed'],
  ['implemented', 'fixed'],
  ['declined', null],
  ['rejected', null],
  ['wontfix', null],
  ['acknowledged', null],
]);

/**
 * The breadcrumb envelope: everything between `agent-merge` and the closing `-->`,
 * captured as one opaque body. Global, because a reply may contain more than one and
 * {@link parseMarker} selects among them.
 *
 * No part of the field grammar is encoded here — not the key names, their order, nor
 * their values — because matching is recognition and any rule spelled into this regex
 * becomes a rule whose violations simply do not match, and a marker that does not match
 * is not reported malformed: it is not seen at all. Encoding the two value shapes
 * (`[a-z-]+`, `\d+`) hid `disposition=Accepted` and `issue=abc`; encoding the key text
 * hid `dispostion=fixed` the same way, which is the likelier typo of the two, since a
 * key is hand-written while a value is drawn from a documented set.
 *
 * The body is therefore tempered rather than a character class: an HTML comment ends at
 * `-->`, not at every `>`, so excluding `>` wholesale re-created the same blind spot for
 * `disposition=a>b`. Tempering also refuses to cross a nested `<!--`, so an envelope
 * that was never closed cannot swallow the real breadcrumb that follows it.
 */
const MARKER = /<!--\s*agent-merge\s+((?:(?!-->|<!--)[\s\S])*?)\s*-->/g;

/**
 * One `key=value` field. The key is matched as loosely as the values, so a misspelling
 * is captured and named rather than failing the match.
 */
const FIELD = /^([^=]+)=(.*)$/;

/** The closed set of keys, per this skill's SKILL.md §Leave a breadcrumb template. */
const MARKER_KEYS = ['disposition', 'issue'];

const ISSUE_NUMBER = /^\d+$/;

/**
 * Disposition values that mean "a marker goes here", not a marker.
 *
 * Prose naming the breadcrumb writes it as `<!-- agent-merge disposition=… -->` — this
 * skill's own documentation does — so a review comment quoting that lands a literal
 * ellipsis in the disposition position. Counting it as drift makes the census report on
 * discussion of itself, and the count grows with every such comment.
 *
 * The angle-bracket form covers this skill's SKILL.md own §Leave a breadcrumb
 * template, `disposition=<one of …>`, which the envelope now reaches: `>` no longer
 * terminates a marker (see {@link MARKER}). Matching the shape rather than that exact
 * string keeps the guard true if the template's wording changes. A leading `<` is the
 * whole test, because fields split on whitespace — the template's value arrives as
 * `<one`, never as a closed `<…>` — and no disposition this script counts can begin
 * with one.
 */
const PLACEHOLDERS = new Set(['…', '...']);

/** `<one of …>` and friends — a value naming its own shape rather than stating one. */
const METAVARIABLE = '<';

/**
 * Whether a captured disposition is a template stand-in rather than a real one.
 *
 * @param {string} disposition
 * @returns {boolean}
 */
function isPlaceholder(disposition) {
  return PLACEHOLDERS.has(disposition) || disposition.startsWith(METAVARIABLE);
}

/** `owner/name`, each segment limited to the characters GitHub actually allows. */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** C0, DEL, and C1 — every byte a terminal may act on rather than print. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Renders remote text safely for a terminal.
 *
 * A review-comment body is untrusted input, and the envelope is deliberately loose
 * enough to capture whatever sits inside it (see {@link MARKER}) — so a marker can
 * carry an escape sequence into a malformed `reason`, which reaches stderr with no
 * flag at all. Left raw, `\u001b[2K` erases the line the census just wrote and
 * `\u001b[31m` recolours what follows: the operator's screen stops matching the data.
 * A marker is not the only remote source on that sink: `main`'s fetch failure reports
 * `execFileSync`'s message, which carries whatever `gh` wrote to its own stderr —
 * a response body included — on precisely the run being read to find out what broke.
 *
 * Only the text renderer expands to `\uXXXX` prose. `--json` is a data path and keeps
 * the exact values — but JSON has its own escape for these bytes, and a `\u007f` in the
 * serialized text parses back to the identical string, so encoding them there costs no
 * fidelity and buys the same safety when the structured output is read on a terminal.
 * `JSON.stringify` already escapes C0 (below `\u0020`); {@link escapeJsonControls} adds
 * DEL and C1, which it emits raw.
 *
 * @param {unknown} text
 * @returns {string}
 */
function visible(text) {
  return String(text).replace(
    CONTROL,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`
  );
}

/** DEL and C1 — the control bytes `JSON.stringify` leaves literal. */
const JSON_UNESCAPED_CONTROL = /[\u007f-\u009f]/g;

/**
 * Re-encodes the control bytes `JSON.stringify` emits raw, as JSON's own `\uXXXX`.
 *
 * Lossless by construction: the escape is part of JSON's string grammar, so `JSON.parse`
 * returns the identical string either way. Only the serialized text changes, which is
 * exactly the surface that reaches a terminal when `--json` is read rather than piped.
 *
 * @param {string} serialized
 * @returns {string}
 */
function escapeJsonControls(serialized) {
  return serialized.replace(
    JSON_UNESCAPED_CONTROL,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * Splits one envelope body into its fields, naming the first structural break it finds.
 *
 * @param {string} text
 * @returns {{ fields: Map<string, string>, malformed: string | null }}
 */
function parseFields(text) {
  const fields = /** @type {Map<string, string>} */ (new Map());
  let malformed = null;
  for (const field of text.split(/\s+/).filter((part) => part.length > 0)) {
    const pair = FIELD.exec(field);
    if (pair === null) {
      malformed ??= `not a key=value field: '${field}'`;
      continue;
    }
    const [, key, value] = pair;
    if (!MARKER_KEYS.includes(key)) {
      malformed ??= `unknown key '${key}'`;
      continue;
    }
    if (fields.has(key)) {
      malformed ??= `duplicate key '${key}'`;
      continue;
    }
    fields.set(key, value);
  }
  return { fields, malformed };
}

/**
 * Extracts the breadcrumb from one review-comment body.
 *
 * An unrecognised disposition is reported rather than silently bucketed: a marker
 * whose vocabulary has drifted from this skill's SKILL.md is the case most worth
 * seeing, and dropping it would hide exactly the divergence this script exists to
 * surface. The same goes for the `issue=` invariant — this skill's SKILL.md requires it
 * on `tracked` and permits it nowhere else, so a marker breaking that is malformed, not
 * a disposition to count.
 *
 * Recognition and validation are deliberately separate steps, for the same reason: see
 * {@link MARKER}. Every rule this function enforces — the key set as much as the two
 * value shapes — is one the envelope must stay loose enough to let through.
 *
 * Key order is not one of those rules. `issue=5 disposition=tracked` states the same
 * thing as the documented order and is counted as such; it is the *set* of keys that is
 * closed, not their sequence.
 *
 * The breadcrumb is the *last* non-placeholder envelope, not the first. §Leave a
 * breadcrumb places it immediately above the bot-authorship footer, so terminal
 * position is what identifies it; a reply that quotes marker syntax while discussing it
 * — which a reply on a thread about this very convention routinely does — otherwise has
 * its real disposition shadowed by the example. Selecting the last envelope rather than
 * the last *valid* one keeps a genuinely broken terminal breadcrumb reportable instead
 * of letting an earlier well-formed example stand in for it.
 *
 * @param {unknown} body
 * @returns {{ disposition: string, issue: number | null, known: boolean, malformed: string | null } | null}
 */
export function parseMarker(body) {
  if (typeof body !== 'string') {
    return null;
  }

  const candidates = [...body.matchAll(MARKER)]
    .map((match) => parseFields(match[1]))
    .filter((parsed) => !isPlaceholder(parsed.fields.get('disposition') ?? ''));
  const parsed = candidates.at(-1);
  if (parsed === undefined) {
    return null;
  }

  const { fields } = parsed;
  let { malformed } = parsed;
  const disposition = fields.get('disposition') ?? '';
  const rawIssue = fields.get('issue');

  const issue = rawIssue !== undefined && ISSUE_NUMBER.test(rawIssue) ? Number(rawIssue) : null;
  const known = DISPOSITIONS.includes(disposition);

  if (malformed === null) {
    if (!fields.has('disposition')) {
      malformed = 'no disposition=';
    } else if (!known) {
      malformed = `unknown disposition '${disposition}'`;
    } else if (rawIssue !== undefined && issue === null) {
      malformed = `issue= is not a number: '${rawIssue}'`;
    } else if (disposition === 'tracked' && issue === null) {
      malformed = "'tracked' with no issue=";
    } else if (disposition !== 'tracked' && issue !== null) {
      malformed = `issue= on '${disposition}'`;
    }
  }

  return { disposition, issue, known, malformed };
}

/**
 * The PR number a review comment belongs to. The REST payload carries no numeric
 * field for it, only `pull_request_url`, so it comes off the end of that path.
 *
 * @param {{ pull_request_url?: unknown } | undefined} comment
 * @returns {number | null}
 */
export function pullNumber(comment) {
  const url = comment?.pull_request_url;
  if (typeof url !== 'string') {
    return null;
  }
  const last = Number(url.split('/').at(-1));
  return Number.isInteger(last) && last > 0 ? last : null;
}

/**
 * Reduces raw review comments to a census, one disposition per thread.
 *
 * Two things this deliberately does not do. It does not count a comment that opens a
 * thread: a disposition is something the run records when it *replies*, so only comments
 * carrying `in_reply_to_id` are eligible, and a marker quoted in a new top-level comment
 * mints nothing. And it does not count a thread twice: several marked replies on one
 * thread collapse to the last, since a later tick's disposition supersedes an earlier one.
 *
 * That is the whole guarantee, and it is weaker than "only the run can set a
 * disposition". A human reply carries `in_reply_to_id` too, so someone quoting the marker
 * syntax mid-thread — while discussing this very convention, most plausibly — takes the
 * thread's disposition under last-reply-wins. Author identity cannot rescue it either:
 * agent merge replies through the user's own token, so `user.login` on a run's reply is
 * the human's login and carries no signal to gate on. Treat the census as a measure of
 * what the convention recorded, not as an authenticated ledger.
 *
 * `deferred` entries carry their link and an excerpt of the reply, because a count
 * cannot be triaged. The excerpt is the run's own first line, not the reviewer's
 * comment, which this payload does not include. Malformed markers carry the same, for
 * the same reason: a bare count of them says drift happened without saying where.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} comments
 * @returns {{ total: number, counts: Record<string, number>, unknown: string[], malformed: Array<{ reason: string, disposition: string, correction: string | null, pr: number | null, url: string, excerpt: string }>, issues: number[], deferred: Array<{ pr: number | null, url: string, excerpt: string }>, byPr: Map<number, Record<string, number>> }}
 */
export function summarize(comments) {
  /** @type {Map<number, { marker: NonNullable<ReturnType<typeof parseMarker>>, comment: Record<string, unknown> }>} */
  const perThread = new Map();

  for (const comment of comments) {
    const marker = parseMarker(comment?.body);
    if (marker === null) {
      continue;
    }
    const threadId = comment?.in_reply_to_id;
    if (typeof threadId !== 'number') {
      continue;
    }
    perThread.set(threadId, { marker, comment });
  }

  const counts = Object.fromEntries(DISPOSITIONS.map((name) => [name, 0]));
  const unknown = [];
  const malformed = [];
  const issues = [];
  const deferred = [];
  const byPr = /** @type {Map<number, Record<string, number>>} */ (new Map());
  let total = 0;

  for (const { marker, comment } of perThread.values()) {
    const pr = pullNumber(comment);
    const url = typeof comment?.html_url === 'string' ? comment.html_url : '';

    if (!marker.known && marker.disposition !== '') {
      unknown.push(marker.disposition);
    }
    if (marker.malformed !== null) {
      malformed.push({
        reason: marker.malformed,
        disposition: marker.disposition,
        correction: OFF_VOCABULARY.get(marker.disposition) ?? null,
        pr,
        url,
        excerpt: excerpt(comment?.body),
      });
      continue;
    }

    total += 1;
    counts[marker.disposition] += 1;

    if (marker.issue !== null && marker.disposition === 'tracked') {
      issues.push(marker.issue);
    }

    if (marker.disposition === 'deferred') {
      deferred.push({ pr, url, excerpt: excerpt(comment?.body) });
    }
    if (pr !== null) {
      const bucket = byPr.get(pr) ?? {};
      bucket[marker.disposition] = (bucket[marker.disposition] ?? 0) + 1;
      byPr.set(pr, bucket);
    }
  }

  return { total, counts, unknown, malformed, issues, deferred, byPr };
}

/**
 * First non-empty line of a reply, trimmed to one terminal row. The marker itself is
 * dropped so the excerpt reads as prose.
 *
 * @param {unknown} body
 * @returns {string}
 */
export function excerpt(body) {
  if (typeof body !== 'string') {
    return '';
  }
  const first = body
    .replace(MARKER, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) {
    return '';
  }
  return first.length > 96 ? `${first.slice(0, 95)}…` : first;
}

/**
 * Builds the paginated review-comments path, oldest first.
 *
 * The ordering is load-bearing, not cosmetic: {@link summarize} resolves a thread that
 * was re-dispositioned across ticks by letting the last marked reply win, and "last" is
 * decided by position in this response. The endpoint's own default cannot carry that —
 * GitHub documents `direction` as defaulting to `desc` when `sort` is `created`, and a
 * host honouring that would silently invert the rule to first-reply-wins and report
 * stale dispositions. Ask for the order the reducer assumes.
 *
 * @param {string} repo
 * @returns {string}
 * @throws when the repo argument is not `owner/name`
 */
export function commentsPath(repo) {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`--repo expects owner/name, received '${repo}'`);
  }
  return `repos/${repo}/pulls/comments?per_page=100&sort=created&direction=asc`;
}

/**
 * The `--jq` projection. `in_reply_to_id` is the load-bearing field: {@link summarize}
 * drops every comment without one, so removing it here empties the census while the CLI
 * still exits 0 and prints "no agent-merge breadcrumbs found" — a failure that reads
 * exactly like a repo nobody has dispositioned yet.
 */
const COMMENT_PROJECTION = '.[] | {body, pull_request_url, html_url, in_reply_to_id}';

/**
 * Builds the argv handed to `gh`. Separate from {@link fetchComments} so the projection
 * and the ordering parameters are assertable without spawning anything.
 *
 * @param {string} repo
 * @returns {string[]}
 * @throws when the repo argument is not `owner/name`
 */
export function commentsArgv(repo) {
  return ['api', '--paginate', commentsPath(repo), '--jq', COMMENT_PROJECTION];
}

/**
 * Runs `gh` and returns its stdout. Replaced wholesale in tests, which is why the argv
 * is built elsewhere: a double installed here sees exactly what the real spawn would.
 *
 * @param {string[]} args
 * @returns {string}
 */
let ghRunner = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GH_PAGER: '' },
  });

/**
 * Swaps the `gh` runner for the duration of `fn`, restoring it even if `fn` throws.
 *
 * @template T
 * @param {(args: string[]) => string} runner
 * @param {() => T} fn
 * @returns {T}
 */
export function withGhRunnerForTest(runner, fn) {
  const previous = ghRunner;
  ghRunner = runner;
  try {
    return fn();
  } finally {
    ghRunner = previous;
  }
}

/**
 * Fetches every review comment in the repo via the `gh` CLI, which supplies the
 * authenticated host and token. Spawned without a shell so the repo argument cannot
 * be re-interpreted, on Windows `cmd.exe` least of all.
 *
 * @param {string} repo
 * @returns {Array<Record<string, unknown>>}
 * @throws when the repo argument is malformed, or `gh` exits non-zero — callers must
 *   catch, since a paginated walk of every review comment can lose to a network blip.
 */
export function fetchComments(repo) {
  const stdout = ghRunner(commentsArgv(repo));
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      /** @type {unknown} */
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('GitHub review-comment output must contain one JSON object per line.');
      }
      return parsed;
    });
}

/**
 * Resolves the repository to census when no `--repo` was given: whichever one the
 * current directory belongs to, according to `gh`.
 *
 * Asks `gh` rather than parsing a git remote, because the answer has to be the repo
 * `gh api` will actually address — remote URL forms, host aliases, and `gh`'s own
 * override resolution are its business, not this script's. Goes through the same
 * injectable runner as {@link fetchComments}, so a caller can substitute it wholesale.
 *
 * @returns {string} `owner/name`
 * @throws when `gh` cannot name a repository — callers must catch, since running
 *   outside a checkout is an ordinary mistake, not an exceptional one.
 */
export function detectRepo() {
  /** @type {string} */
  let detected;
  try {
    detected = ghRunner(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  } catch (error) {
    throw new Error(
      `\`gh repo view\` failed (${error.message}). Run inside a checkout, or pass --repo owner/name.`
    );
  }
  if (!REPO_PATTERN.test(detected)) {
    throw new Error(
      `\`gh repo view\` did not name a repository (got ${JSON.stringify(detected)}). Run inside a checkout, or pass --repo owner/name.`
    );
  }
  return detected;
}

/**
 * Extracts the disposition vocabulary from this skill's SKILL.md, in the three places it
 * has to agree with itself:
 *
 *   `template`   the alternation inside the fenced marker example
 *   `defined`    the glossary lines, each `<name>` followed by an em dash
 *   `instructed` every other candidate backticked mention, plus the house "mark
 *                the thread `<name>`" directive shape — the prose that actually
 *                tells an agent to apply one
 *
 * This exists because the same defect has landed three times: a disposition defined in
 * the vocabulary that no branch of the prose ever produces (`inapplicable`, then
 * `fixed`), and prose demanding a marker for a state the vocabulary has no name for (an
 * escalation reply). Both are invisible to a reader editing one section at a time. The
 * glossary is anchored to its heading and parsed without consulting the fenced template:
 * a file-wide "backticked term followed by em dash" scan would treat any unrelated
 * definition as a disposition and widen the candidate set below. The instructing prose
 * is bounded by `template ∪ defined ∪ directiveNames`; bounding by `template` alone
 * would hide a prose and glossary name that the marker example omitted, while the
 * anchored glossary keeps unrelated backticked command names out of `defined` and the
 * prose candidates. The directive shape catches a new section that says to mark the
 * thread with a name missing from the glossary, without reopening the file-wide em-dash
 * false positive. It is still not an arbitrary prose parser: a new disposition
 * definition belongs under `### Dispositions`, and an out-of-glossary definition that
 * avoids the directive phrase remains a convention gap. {@link DISPOSITIONS} and this
 * parser are pinned against each other in the test suite rather than by eye.
 *
 * @param {string} markdown
 * @returns {{ template: string[], defined: string[], instructed: string[] }}
 */
export function documentedDispositions(markdown) {
  const fenced = markdown.match(/```[\s\S]*?```/g) ?? [];
  const template = [];
  for (const block of fenced) {
    const alternation = /disposition=<([a-z|]+)>/.exec(block);
    if (alternation !== null) {
      template.push(...alternation[1].split('|'));
    }
  }

  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  const glossary =
    /^#{2,6}\s+Dispositions\b[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s+|(?![\s\S]))/m.exec(prose)?.[1] ?? '';
  const defined = [...new Set([...glossary.matchAll(/`([a-z]+)`\s+—/g)].map((match) => match[1]))];
  const directiveNames = [...prose.matchAll(/\bmark(?:ing)?\s+the\s+thread\s+`([a-z]+)`/gi)].map((match) =>
    match[1].toLowerCase()
  );
  const candidates = new Set([...template, ...defined, ...directiveNames]);

  const instructed = [
    ...[...prose.matchAll(/`([a-z]+)`(?!\s+—)/g)]
      .map((match) => match[1])
      .filter((name) => candidates.has(name)),
    ...directiveNames,
  ];

  return { template, defined, instructed: [...new Set(instructed)] };
}

/**
 * Reads the `### Not dispositions` table — the tokens this skill's SKILL.md names as
 * wrong, and the disposition each one should have been.
 *
 * A row's correction counts only when the right cell is exactly one backticked token
 * and nothing else. That is what lets an ambiguous row explain itself in prose,
 * backticked disposition names included, without a reader of this parser having to
 * decide which of the two it meant. Anchored to its own heading for the same reason
 * {@link documentedDispositions} anchors the glossary: a file-wide table scan would
 * treat any unrelated two-column table as vocabulary.
 *
 * @param {string} markdown
 * @returns {Map<string, string | null>}
 */
export function documentedOffVocabulary(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  const section =
    /^#{2,6}\s+Not dispositions\b[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s+|(?![\s\S]))/m.exec(prose)?.[1] ?? '';

  /** @type {Map<string, string | null>} */
  const off = new Map();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4) {
      continue;
    }
    const written = [...cells[1].matchAll(/`([a-z-]+)`/g)].map((match) => match[1]);
    if (written.length === 0) {
      continue;
    }
    const sole = /^`([a-z-]+)`$/.exec(cells[2]);
    const correction = sole !== null && DISPOSITIONS.includes(sole[1]) ? sole[1] : null;
    for (const token of written) {
      off.set(token, correction);
    }
  }
  return off;
}

/**
 * @param {string[]} argv
 * @returns {{ repo: string | null, json: boolean, byPr: boolean, deferred: boolean, malformed: boolean }} `repo` is null when no `--repo` was given, so the caller resolves it
 */
export function parseArgs(argv) {
  const repoFlag = argv.indexOf('--repo');
  return {
    repo: repoFlag === -1 ? null : (argv[repoFlag + 1] ?? ''),
    json: argv.includes('--json'),
    byPr: argv.includes('--by-pr'),
    deferred: argv.includes('--deferred'),
    malformed: argv.includes('--malformed'),
  };
}

/**
 * Builds the whole report as text, so the output contract is assertable without a
 * process or a network round trip. `main` only chooses a repo, fetches, and prints —
 * everything a reader sees is decided here.
 *
 * @param {{ summary: ReturnType<typeof summarize>, repo: string, json?: boolean, byPr?: boolean, deferred?: boolean, malformed?: boolean }} options
 * @returns {{ out: string[], err: string[] }} stdout lines, and stderr lines without the prefix `logError` adds
 */
export function renderReport({
  summary,
  repo,
  json = false,
  byPr = false,
  deferred = false,
  malformed = false,
}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];

  if (json) {
    out.push(
      escapeJsonControls(JSON.stringify({ ...summary, byPr: Object.fromEntries(summary.byPr) }, null, 2))
    );
    return { out, err };
  }

  if (summary.total === 0 && summary.malformed.length === 0) {
    out.push(`[agent-merge-stats] no agent-merge breadcrumbs found in ${repo}.`);
    out.push('[agent-merge-stats] expected once an unattended run has dispositioned a thread.');
    return { out, err };
  }

  out.push(
    `[agent-merge-stats] ${summary.total} dispositioned thread(s) across ${summary.byPr.size} PR(s) in ${repo}`
  );
  for (const name of DISPOSITIONS) {
    out.push(`  ${name.padEnd(14)} ${summary.counts[name]}`);
  }
  if (summary.issues.length > 0) {
    out.push(`  tracked issues: ${summary.issues.map((issue) => `#${issue}`).join(', ')}`);
  }
  if (summary.malformed.length > 0) {
    out.push(
      `  ${'malformed'.padEnd(14)} ${summary.malformed.length}  (uncounted — list them with --malformed)`
    );
    err.push(
      `${summary.malformed.length} malformed marker(s), not counted as a disposition: ${[...new Set(summary.malformed.map((item) => visible(item.reason)))].join('; ')}`
    );
  }

  if (byPr) {
    out.push('');
    for (const [pr, buckets] of [...summary.byPr].sort(([left], [right]) => left - right)) {
      const detail = Object.entries(buckets)
        .map(([name, count]) => `${name}=${count}`)
        .join(' ');
      out.push(`  #${pr} ${detail}`);
    }
  }

  if (deferred) {
    out.push('');
    if (summary.deferred.length === 0) {
      out.push('[agent-merge-stats] nothing deferred yet.');
    } else {
      out.push(`[agent-merge-stats] ${summary.deferred.length} suggestion(s) the scope rule turned away:`);
      for (const item of summary.deferred) {
        out.push(`  #${item.pr ?? '?'} ${visible(item.excerpt)}`);
        out.push(`      ${visible(item.url)}`);
      }
      out.push('');
      out.push('[agent-merge-stats] Triage these into issues in one pass; the agent files none itself.');
    }
  }

  if (malformed) {
    out.push('');
    if (summary.malformed.length === 0) {
      out.push('[agent-merge-stats] every marker is well formed.');
    } else {
      out.push(`[agent-merge-stats] ${summary.malformed.length} marker(s) counted as no disposition at all:`);
      for (const item of summary.malformed) {
        const correction = item.correction === null ? '' : ` — should have been \`${item.correction}\``;
        out.push(`  #${item.pr ?? '?'} ${visible(item.reason)}${correction}`);
        out.push(`      ${visible(item.url)}`);
      }
      out.push('');
      out.push('[agent-merge-stats] A correction is reported, never applied — nothing here is re-bucketed.');
      out.push(
        "[agent-merge-stats] Off-vocabulary tokens belong in this skill's SKILL.md `Not dispositions`."
      );
    }
  }

  out.push('');
  out.push('[agent-merge-stats] `fixed` counts what the run changed, not what it should have.');
  out.push('[agent-merge-stats] Drift still needs a sampled read of those diffs.');

  return { out, err };
}

/**
 * Wires flags to output: parse, fetch, summarize, render, then emit.
 *
 * The writers are injectable so the seam itself is testable. Covering `parseArgs` and
 * {@link renderReport} separately leaves this wiring mutation-survivable — dropping a
 * flag on the way through, or dropping the `err` loop entirely, keeps every helper test
 * green while the documented behaviour disappears.
 *
 * @param {{ argv?: string[], write?: (line: string) => void, writeError?: (line: string) => void, fetch?: (repo: string) => unknown[], resolveRepo?: () => string }} [options]
 * @returns {{ exitCode: number }}
 */
export function main({
  argv = process.argv.slice(2),
  write = log,
  writeError = logError,
  fetch = fetchComments,
  resolveRepo = detectRepo,
} = {}) {
  const { repo: repoFlag, json, byPr, deferred, malformed } = parseArgs(argv);

  let repo;
  try {
    repo = repoFlag ?? resolveRepo();
  } catch (error) {
    writeError(`could not determine which repository to census: ${visible(error.message)}`);
    return { exitCode: 1 };
  }

  let comments;
  try {
    comments = fetch(repo);
  } catch (error) {
    writeError(`could not read review comments for ${repo}: ${visible(error.message)}`);
    writeError('Check `gh auth status` against the host serving this repo, and retry — a paginated');
    writeError('walk of every review comment is long enough to lose to a transient network failure.');
    return { exitCode: 1 };
  }

  const { out, err } = renderReport({ summary: summarize(comments), repo, json, byPr, deferred, malformed });
  for (const line of out) {
    write(line);
  }
  for (const line of err) {
    writeError(line);
  }

  return { exitCode: 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { exitCode } = main();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
