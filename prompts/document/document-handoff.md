Produce a complete handover dossier for one area of this application, aimed at an engineer who is about to take ownership of it and currently knows nothing about it. The output is a single self-contained HTML page written to the local filesystem — a reference they will keep open while working, not a one-time read.

The invocation names the area. Accept any of these forms and resolve them to a file set before writing anything:

- a route or URL path (`/reports/profitability-dashboard`, `/dispatch/board`)
- a directory (`apps/portal/src/components/planner`, `apps/jobs/src/dispatch-engine`)
- a subsystem or feature name in prose ("the recommendation engine", "driver directory", "the leg projection job")
- an API surface (`/api/dispatch/*`)

If the name resolves ambiguously — two plausible areas, or a name that spans a UI surface and an unrelated backend job — state the candidates and the file counts, pick the reading that matches the user's evident intent, say which you picked in one line, and proceed. Do not stop to ask unless proceeding under either reading would waste the whole run.

Provenance (record this before you read anything):

- Capture the commit the dossier describes, before you start reading: `git rev-parse HEAD` for the full SHA, `git rev-parse --short HEAD` for display, plus the branch name and whether the working tree was dirty at the time (`git status --porcelain`). A dossier written against uncommitted work describes a state no one else can check out, so if the tree is dirty, say so in the provenance line rather than pretending the SHA is the whole story.
- Put a **provenance line directly under the page title**, above the executive summary, reading like: `Documented at a1b2c3d (main) · 8 September 2026 · 47 files`. Keep it visible; a reader's first question about any dossier is how old it is.
- Immediately after it, emit a machine-readable marker as an HTML comment, on one line, with the **full** SHA:

```
<!-- doc-provenance: sha=<full-sha> short=<short-sha> branch=<branch> date=<YYYY-MM-DD> dirty=<true|false> area=<area-slug> -->
```

- That comment is what a later run reads to update the dossier instead of rebuilding it. Emit it exactly in that shape, one `key=value` pair per field, no line breaks inside it — a later run greps for `doc-provenance`, and a reformatted marker is an unreadable one. Never hand-edit it; it is written by the run that produced the page.
- Maintain a **Documentation history** section as the last section of the page: a table of every run, most recent first, with the short SHA, the full SHA, the date, whether that run was a full build or an update, and a one-line summary of what changed in the docs. Append to it; never replace it. The history is what tells a reader whether a section has been reviewed since the code under it moved.

Scope resolution (do this first, before reading deeply):

- Enumerate the full file set: page/entry points, route handlers, data-access modules, SQL, components, hooks, shared primitives it composes, types and schemas, config, and the tests that cover it. Include line counts.
- Follow imports outward one hop past the area's own directory, so shared seams it depends on (a pool, a cache factory, a route scaffold, a table primitive) are named and understood, not treated as opaque.
- Identify what is *out* of scope and say so explicitly in the dossier — especially other consumers of the same data or components, which are the usual source of "I changed one thing and broke another".
- Note where the area's boundary is: what it owns versus what another repository, another service, or a scheduled job owns. **This is often the single most important fact about an area and it is rarely written down anywhere.**

Updating an existing dossier (check for this before doing scope resolution):

Re-running as the area changes is the expected workflow, and re-reading the whole tree every time is the wrong way to do it. When a prior dossier exists, work from the delta.

- Look for `.local/<area-slug>/index.html`. If it exists, grep it for `doc-provenance` and read the prior SHA. If the file exists but has no marker, it predates this rule: rebuild fully and emit one.
- **Confirm the prior SHA is still reachable and an ancestor of HEAD**: `git cat-file -e <prior-sha>` then `git merge-base --is-ancestor <prior-sha> HEAD`. If either fails, the branch was rebased, squashed, or the commit is gone, and a diff against it would be fiction. Say so in one line and rebuild fully.
- If the prior run recorded `dirty=true`, treat its baseline as approximate: the diff will not include whatever was uncommitted then. Say so, and widen the re-read to the whole area if the uncommitted work looks material.
- With a valid baseline, scope the update from `git diff --stat <prior-sha>..HEAD -- <area paths>` and `git log --oneline <prior-sha>..HEAD -- <area paths>`.
- **If nothing in the area changed**, do not rebuild and do not re-read the code. Append a Documentation history row recording the new HEAD, the date, "no change", and update the provenance line and marker to the new SHA. Say in chat that the dossier is current as of the new commit and nothing needed rewriting. This is the cheap path and it should be genuinely cheap.
- **If the area changed**, read only the changed files and the one hop around them, then update the sections those files feed. Rewrite what moved; leave the rest alone. The dossier's value is in its accumulated detail, so do not regenerate a section wholesale when a paragraph is wrong.
- **Some verification passes are not local, and a diff scoped to the area will not tell you they broke.** Re-run these whenever anything changed anywhere in the repository since the prior SHA, not merely inside the area:
  - **Dead exports** — an import removed in a distant file is exactly what turns a live export dead, and it never appears in the area's own diff. Re-grep the area's exports repository-wide.
  - **Computed but never rendered** — the same in reverse: a consumer deleted elsewhere strands a field that still looks used.
  - **Consistency across siblings** — a sibling endpoint changing its rounding or filtering is a change to this area's correctness story even though no file here moved. Check `git log <prior-sha>..HEAD` for the siblings named in that section.
  - **Doc-vs-code drift** — re-verify any claim whose supporting code appears in the diff, and any claim in a repository instruction file that itself changed.
- Cheap-path exception: if `git diff <prior-sha>..HEAD` is empty for the entire repository, skip those passes too. Nothing can have drifted.
- **Findings ids are stable across runs.** Never renumber. A finding that is now fixed stays in the table marked resolved, with the commit that resolved it; deleting it destroys the record that it was ever true. New findings continue the sequence from the highest id ever used, including resolved ones.
- Preserve any section a reader may have come to rely on, including "Things that look wrong and are not" — a deliberate choice recorded there stays true until the code changes, and re-deriving it from scratch is how it gets lost.
- Say in the chat summary which sections were updated, which were left untouched, and which non-local passes you re-ran. A reader needs to know what was actually re-checked rather than assuming the whole page was.
- If the user asks for a full rebuild, do one and record it in the history as a full build. Prefer a rebuild when the delta touches more than roughly half the area's files — at that point the update is more work than the rebuild and likelier to leave a stale seam behind.

Reading order (follow it — it is what makes the output accurate rather than plausible):

1. The repository's own instructions for the area: `CLAUDE.md`, `AGENTS.md`, `.github/instructions/*.instructions.md`, `.github/copilot-instructions.md`, and any `DECISIONS.md` / `RECONCILIATION.md` / `*-NOTES.md` sitting beside the code. These record arguments already settled — read them before forming an opinion, so you neither re-litigate a deliberate choice nor repeat a claim that has since gone stale.
2. `git log --oneline -- <paths>` over the area, plus the merge commits that reshaped it. The shape of the history explains the shape of the code, and it is how you detect that surviving prose describes an earlier design.
3. The data layer bottom-up: the query or fetch, then the mapping, then the assembly, then the route, then the component tree. Reading top-down makes you guess at the numbers; reading bottom-up makes you know them.
4. The tests last, as evidence of intended behavior and as a source of concrete example values.

Verification passes (run every one that applies — these produce the findings that justify the exercise):

- **Doc-vs-code drift.** For every factual claim in the area's own documentation and in any user-visible copy (footnotes, tooltips, help text, empty states, error messages), verify it against the code. A page that misstates its own methodology is a higher-value finding than most bugs. Quote the claim and the contradicting code.
- **Dead exports.** For each exported symbol in the area, grep for imports outside its own file and test file. Report symbols with none. Pay particular attention to constants and SQL fragments that *look* authoritative — a stale exported constant is the fastest way for the next person to misunderstand the system.
- **Computed but never rendered.** Trace each field the backend produces to a consumer. Fields that are queried, mapped, transmitted and validated but never displayed are either a missing feature or dead weight; both are worth naming.
- **Unbounded work.** For every input that reaches a query, a loop, a fetch, or an allocation, find the bound. Note where sibling endpoints disagree about limits — a cap on one route and none on its neighbour is a real gap, not a style difference.
- **Absent-versus-zero.** Check how missing values are handled at each layer. Silent coercion of null/empty to `0` in a numeric or financial surface is a correctness finding, not a nitpick.
- **Consistency across siblings.** Where several endpoints, tabs, or panels present the same underlying data, check that they filter, round, and label it identically. Where they differ, decide whether it is deliberate and say which.
- **Authorization.** Identify where authentication is enforced and whether any authorization check applies inside the area. If sensitive data (pay, PII, financials, customer records) is readable by any authenticated user, say so plainly as an observation, and note whether the codebase already has a gating mechanism that was not applied here.
- **Test-coverage honesty.** Note tests that cover code no user can reach, and behavior with no coverage at all. Coverage that exercises dead code makes that code look load-bearing.

Hard constraints:

- **Read-only.** Do not modify, refactor, or "fix" anything in the area. Do not commit, push, or open a PR. The only file you create is the dossier (plus any assets it needs).
- Do not run migrations, write to any database, or invoke anything with side effects outside the repository.
- Do not connect to a live database, cloud account, or external service without asking first. Where a fact would need one to confirm (a table's real DDL, a row count, current config), **derive what you can from the code, mark it explicitly as reconstructed, and say what it would take to verify.** Never present an inference as a confirmed fact.
- Do not run the full test suite or a build unless the user asks. Reading tests is in scope; executing them is not.
- Every factual claim in the dossier must be traceable to a file path you actually read. Cite paths inline. Where you cite a line number, re-derive it from the real file, never from a scratch diff.
- Where you could not determine something, say so in the dossier rather than omitting it. An explicit "this is not written down anywhere; the ETL repo owns it" is more useful than silence.

Output artifact:

- Write one self-contained HTML file to `.local/<area-slug>/index.html` at the repo root, where `<area-slug>` is the area name lowercased with non-alphanumerics collapsed to `-`. `.local/` is gitignored, so the dossier never appears in `git status` or a diff.
- Self-contained means: no external scripts, stylesheets, fonts, or images. Inline everything. Diagrams are inline SVG. The file must open correctly from `file://` with no network.
- If the area genuinely warrants companion assets (a large extracted dataset, a generated CSV), put them alongside in the same directory and link them relatively. Prefer one file.
- Overwrite the file if a prior run produced one, but carry its Documentation history and finding ids forward — see "Updating an existing dossier". Re-running as the area changes is the expected workflow, and after the first run it should normally be an update rather than a rebuild.
- Also print a short chat summary: where the file is, the `open` command, the three things worth knowing before reading it, and the highest-value findings. Do not paste the dossier into chat.
- Send the file to the user with SendUserFile so it reaches them on whatever device they are on.

Page structure (use this skeleton so dossiers for different areas read alike; drop a section that genuinely does not apply and say in one line why):

1. **Executive summary** — what the area is, the one sentence that explains the whole thing, a small stat block (entry points, routes, queries, file count), a five-line mental model, and a short table of how the area evolved with the commits that reshaped it.
2. **Architecture at a glance** — one inline-SVG flow diagram from source of truth to rendered surface, with the repository boundary drawn explicitly, followed by a layer-contract table (layer, where, responsibility, hard rule).
3. **The data foundation** — stores, connections, pools, the tables or APIs it reads, a column/field inventory with where each one surfaces, and upstream lineage. Mark reconstructed schemas as reconstructed.
4. **How every number (or every behavior) is computed** — the reference section. For a reporting surface: each visible figure traced to the exact SQL or expression, the coercion applied, and the formatter. For a non-reporting surface: each state transition, side effect, and decision rule traced to the code that implements it. This is the longest section and the one that earns the dossier's keep.
5. **The HTTP / interface surface** — every route or public entry point in one table: path, params, validation, failure modes, caching, loader.
6. **The internal layer** — the patterns and primitives the area is built from, and the rule each one enforces.
7. **The UI surface** (if any) — the component tree as an annotated ASCII tree, then what each region does.
8. **State and contracts** — URL params, client state, wire shapes, runtime validation, and the invariants that are actually asserted.
9. **Caching, performance and failure** — a cache/timing diagram where there are layers, the cost profile of the expensive paths, and what happens when each dependency is slow or down.
10. **Domain-specific deep dive** — the one subsystem within the area that a newcomer will most misread. Give it its own section with a table of its vocabulary.
11. **Provenance and reconciliation** (where the area produces numbers anyone checks against another source) — what has been reconciled, to what, how closely, and what the remaining gap is.
12. **Issues, risks and drift** — numbered findings, `F-01`…, ordered by cost to the reader. Rules below.
13. **File index** — every non-test file with line count and a one-line "owns" description, grouped by layer, with a live filter box.
14. **Taking it over** — how to run it locally, a reading order for the first day, a "you want to X → touch Y → watch out for Z" table, questions worth asking the product or data owner in week one, and the five sentences to remember.
15. **Documentation history** — the run table described under "Provenance", most recent first. Keep it last; it is reference, not reading.

Findings rules (section 12):

- Give each finding a stable id (`F-01`), a category chip (correctness, cost, performance, consistency, dead code, stale docs, access control, UX, naming), a one-line title that states the defect, the evidence with file paths, the concrete failure scenario or cost, and the fix with a rough size.
- Order by cost to the reader, not by severity label alone: the thing that will waste their first week outranks a theoretical edge case.
- Report only what you can support from cited code. No speculation. If something is suspicious but unproven, say what would prove it.
- Mark clearly that the findings are your assessment, not the team's recorded position.
- Include a closing subsection: **"Things that look wrong and are not."** List the deliberate choices a reviewer will reflexively flag, with the reason and the document that records it. This is what stops the next person from "fixing" something three times, and it is often the most valuable half-page in the dossier.

Design and writing standards:

- Theme-aware: define the full light palette on `:root`, redefine only the changed tokens under `@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]` so an explicit toggle wins both ways. Give `body` an explicit background. Never give a color its only definition inside a media block.
- Sticky sidebar navigation with the full section list and scrollspy; a theme toggle; a filter input over the file index. Keep the JavaScript small, dependency-free, and wrapped so a failure cannot blank the page. Wrap `localStorage` access in `try`/`catch`.
- Wide content (tables, diagrams, code) scrolls inside its own container. The page body must never scroll horizontally. Give the layout a mobile breakpoint.
- Diagrams earn their place by showing a mechanism a paragraph cannot: a flow across a boundary, a layering, a state machine. Do not draw a box diagram that restates a list. Style SVG shapes with the page's own CSS tokens so they follow the theme, and keep stroke and text colors at least one contrast step off the background — a dark-on-dark diagram is invisible in dark mode.
- Write for a competent engineer who lacks context, not for a beginner and not for the person who wrote it. Prefer the concrete number, the exact expression, the real path. Bold the load-bearing sentence in a section; do not bold half the page.
- Never invent a figure, a date, a commit hash, or a metric. Every number in the dossier comes from a file you read or a command you ran.

Before finishing, verify the artifact:

- Parse the HTML and confirm it is well-formed with no unclosed tags.
- Confirm every internal `href="#…"` resolves to an id that exists on the page.
- Confirm every file path cited in the dossier exists.
- Open the page in a browser and look at it. Check the top of the document, at least one diagram, and one wide table. If the preview harness only captures the first viewport, verify the rest programmatically (computed styles, element geometry) and say in chat which parts you confirmed visually and which structurally.
- Report the file size. If it exceeds ~1 MB, the content has gone wrong — tighten rather than split.
