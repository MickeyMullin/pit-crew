Transform an existing handover dossier into a client-facing overview of the same area. The input is an artifact produced by `document-handoff.md`; the output is a separate self-contained HTML page written for a technically literate client — someone who understands software and can read a diagram, but does not work on this codebase, will never open it, and is not taking ownership of anything.

This is a transformation, not a second review. Work from the dossier. Re-read code only to confirm something you are restating or to resolve an ambiguity the dossier left; never go hunting for new findings, and never introduce a fact the dossier does not support.

Input:

- The invocation names either an area (resolve it to `.local/<area-slug>/index.html`) or a path to a dossier directly.
- If no dossier exists for the area, stop and say so. Run `document-handoff.md` first — this prompt does not build one, because a client document derived from a fresh unreviewed read has had none of the verification the dossier's process provides.
- Read the whole dossier before writing anything, including its provenance marker and its Documentation history.

Carry the provenance forward:

- Read the source dossier's `doc-provenance` marker. The client page describes the same commit, so it inherits the same SHA.
- Emit the client page's own marker, on one line, naming both the commit and the dossier it came from:

```
<!-- doc-provenance: sha=<full-sha> short=<short-sha> branch=<branch> date=<YYYY-MM-DD> area=<area-slug> derived-from=index.html source-date=<source dossier's date> -->
```

- Show the reader a **date, not a SHA**. A line under the title reading `Current as of 8 September 2026` is what a client needs; a commit hash means nothing to them and invites a question you do not want to answer. Keep the SHA in the marker only.
- Maintain the same **Documentation history** table, last on the page, with one row per run: date, whether it was a full build or an update, and a one-line summary. Give the columns client-legible headings and no SHA column — the marker carries that.
- **Update by delta, exactly as the dossier does.** On a re-run, compare the source dossier's current provenance SHA against the `source-date`/`sha` this page was built from. If they match and the dossier has not changed, nothing needs rewriting: append a history row and say so. If the dossier moved, re-read only its changed sections and update the corresponding client sections. Prefer a rebuild when more than roughly half the dossier changed.

The lead section (this page's distinguishing feature — write it first, and write it last):

- Open with a **plain-language description of what this area does**, before any diagram, table, or technical term. Three to six short paragraphs, no jargon, no file paths, no component names.
- Answer, in this order: what business problem this area solves; who uses it and what they are trying to accomplish; what it does with the information it is given; and what someone would notice if it were switched off tomorrow.
- Write it so a non-technical stakeholder — an operations lead, a finance director, someone on the client's board — can read it start to finish and correctly describe the area to a colleague afterwards. That is the test. The rest of the page assumes technical literacy; this section assumes none.
- Do not lead with technology. "This area calculates what each job costs to run and shows it against what was quoted" is a lead. "This is a Next.js route group backed by a Postgres read replica" is not, and belongs further down.
- Where a domain term is unavoidable, define it in the sentence that first uses it, and repeat the definition in the glossary rather than assuming the lead was read.

What to remove (the dossier is written for someone taking ownership; almost none of that framing survives):

- **All handover framing.** No "handover", "taking it over", "the next person", "onboarding", "your first day", "in week one", "the outgoing engineer", "you will inherit". Delete the "Taking it over" section entirely; nobody reading this is taking anything over.
- **All internal-development furniture.** Local setup instructions, reading orders, the file index, line counts, directory paths, component names, test names, commit history, branch names, author names, PR and ticket numbers.
- **The findings section, by default.** `F-01`-style defect lists are an internal engineering assessment: they name things the client is paying to have work, they are framed as criticism of delivered software, and they carry remediation sizes that read as a bill. Do not carry them across on your own initiative. See "Findings" below, which is the one part of this transformation that needs a decision rather than a rule.
- **"Things that look wrong and are not"** — it answers an objection only a reviewing engineer would raise, and raising it here plants a doubt the reader did not have.
- **Test-coverage honesty, dead code, drift, and TODOs.** All of it is a conversation about the health of the codebase, which is a conversation to have with the client deliberately and in person, not to publish as a page they read alone.
- **Speculative or hedged language about defects.** Anything the dossier marked as suspicious-but-unproven does not appear here at all. A client cannot act on it and cannot evaluate it.

What to keep, and how to change it:

- **What the area does, and how it is put together.** Keep the architecture diagram, redrawn without repository boundaries, module names, or file paths — boxes named for what they do ("Quote intake", "Cost calculation", "Reporting surface"), not what they are called in the source.
- **How every number is computed.** Keep this; for most clients it is the single most valuable section, because it is the auditable explanation of figures they rely on. Restate each calculation as a formula or a sentence in domain terms. Drop the SQL, the expression, and the file path; keep the rounding, the units, the cut-off dates, and the edge cases, which are exactly what a client needs to reconcile a number they disagree with.
- **Where the data comes from.** Keep lineage and sources described by system and ownership ("supplied nightly by the scheduling system"), not by table name or connection string. Keep any schema the dossier marked reconstructed clearly marked as inferred rather than confirmed — a client acting on a guess presented as fact is a worse outcome here than in the dossier.
- **Provenance and reconciliation.** Keep in full where it exists. What was checked against what, how closely it agreed, and what gap remains is the strongest trust-building content on the page.
- **Behavioral rules and business logic.** State transitions, decision rules, and what triggers what, described in domain vocabulary.
- **Boundaries.** Keep the "what this area does not do" content and make it prominent. Say which neighbouring capability belongs to a different system, without naming repositories or services. Misplaced expectation about scope is the most common and most expensive client misunderstanding, and this section is the cheapest place to prevent it.
- **A glossary.** Every domain term the page uses, defined plainly. The dossier's deep-dive vocabulary table is usually the seed for this.
- **Known limitations, stated as behavior rather than as defects.** "Figures exclude jobs cancelled before dispatch" is a limitation a client needs and can plan around. "F-04: cancelled jobs are not filtered, causing inflated totals" is a defect report. Where the dossier's finding describes a real constraint on how the software behaves today, carry the constraint across in the first form. Where it describes something simply broken, that is a conversation, not a page — see below.

Findings — ask, do not decide:

- Some findings genuinely belong in front of a client, and quietly dropping every one of them produces a document that is misleading by omission. Others should never be published, particularly anything describing an access-control weakness, which is a security disclosure and belongs in a direct conversation with a named owner, never in a document that may be forwarded onward.
- So: list every finding in chat, grouped as **would omit** (internal quality, dead code, drift, test coverage, cost-to-fix), **would restate as a limitation** (real constraints on current behavior a client should plan around), and **must not publish without your say-so** (access control, data exposure, anything about PII, pay, or financial correctness). Say what you would do with each and why.
- Default to omitting. Include a finding only on the user's explicit instruction, and when they say to include one, restate it as behavior and consequence in domain language rather than as a defect with a remediation estimate.
- Never publish a security or data-exposure finding on this page on your own judgment, even when the user has approved including other findings. Ask about those specifically and separately, every time.
- After writing, say plainly in chat which findings were included and which were withheld, so nobody is left believing the client has seen something they have not.

Tone and register:

- Confident and plain. The software works and this document explains it; that is the register. Neither defensive nor promotional — no "robust", "seamless", "cutting-edge", and equally no apologising for how something was built.
- Use the client's domain vocabulary, not the codebase's. Where the code's name for a concept differs from the business's name, use the business's and note the equivalence once in the glossary. A dossier that calls something a `LegProjection` describes a business object the client already has a word for; find that word.
- Present tense, active voice, no hedging about what the software does today. Reserve conditional language for genuine uncertainty, and mark it as such.
- Say "the system", "the platform", or the product's own name. Never "we", "our team", "the developers", or "the client" — the reader is the client, and being referred to in the third person on a page written for them reads badly.
- Do not name individuals anywhere.

Output artifact:

- Write to `.local/<area-slug>/client.html`, alongside the dossier it derives from. Do not overwrite `index.html` under any circumstances — the two documents have different audiences and the dossier is the source this one is rebuilt from.
- Follow `document-handoff.md`'s **Design and writing standards** and its **Before finishing, verify the artifact** steps in full: self-contained, theme-aware, sticky navigation, inline SVG, well-formed HTML, resolving anchors, checked in a browser, size reported. They are not repeated here so that the two pages cannot drift apart in style; read them there.
- Two differences from those standards: there is no file-index filter to build, and no citation of file paths — where the dossier cites a path inline, the client page carries the claim without the citation. Every claim must still be traceable to the dossier, which remains the auditable record.
- Print a short chat summary: where the file is, the `open` command, what the lead section says in one line, which sections were carried across, and the findings disposition described above. Do not paste the page into chat.
- Send the file to the user with SendUserFile.

Before finishing, read the page back as the client would:

- Read the lead section aloud. If it contains a word the reader would have to look up, or a sentence that only makes sense to someone who has seen the code, rewrite it.
- Grep your own output for the removed vocabulary: `handover`, `hand-over`, `take over`, `taking it over`, `onboard`, `week one`, `the next person`, `codebase`, `repo`, `repository`, `refactor`, `technical debt`, `TODO`, `F-0`. Any hit is either a mistake or a deliberate exception you should be able to justify.
- Confirm no file path, module name, table name, branch name, or commit hash appears in the visible text.
- Confirm every number on the page appears in the source dossier. This document introduces no new facts.
