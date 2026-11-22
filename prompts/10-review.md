<!-- Review cartridge. Variables: {{REQUEST}} {{RULES}} {{STRONG}} {{TARGET}} {{BASE}} {{CHECKS}} {{SCOPE}} {{SUMMARY}} {{CODEX_REVIEW}} -->
Task: REVIEW code. Read only: do not change product code and do not commit.

{{REQUEST}}

This folder is a separate checkout made for reviewing. The console has already moved it to the latest commit of {{TARGET}}.
Scope: {{SCOPE}}
If plans/context/ exists, it holds the spec and plan of the work under review; read them to know the intent.

{{RULES}}

{{CHECKS}}

Spawn 3 teammates (model {{STRONG}}), all READ ONLY:
- "security": auth, authorization, injection, leaked secrets, input validation
- "logic": does it do what was asked, edge cases, error handling, race conditions, backward compatibility; the
  Design check
- "quality": tests, docs and skills (checks 3 to 5), the project's coding standards in plans/coding-standards.md
  (tests that cannot fail included), performance, dead or hard-to-maintain code, places that should reuse existing code
Each finding: file:line - severity (critical/major/minor) - why - how to fix - reproduction command if any.
Then cross-check: drop any finding another reviewer proves wrong. No generic praise.
While they review, run the code-review skill yourself at level high on what this review covers (/code-review high
with the pull request number, or with {{TARGET}} when there is none). It runs in the background and reports when it
is done: wait for its findings before you write the report or reply. Check each finding at its file:line: a real one
joins the findings with its severity, tagged [code-review]; a wrong one goes under "Dropped" with one line why.
{{CODEX_REVIEW}}

The lead writes plans/review-report.md. Its first line is "Merge danger: one-way door - <why>" or
"Merge danger: two-way door - <why>", judged from the diff against the Merge danger section of
plans/coding-standards.md. Then:
1. A 3-line summary, a table of the quality checks above (pass / fail), and a verdict: READY TO MERGE / NEEDS WORK / DO NOT MERGE
2. Findings by severity (keep only those confirmed by at least one other reviewer)
3. Result of the existing tests (only if they run without changing anything)
4. Questions for the author
When it is done, start your reply with the line "REVIEW DONE", then the verdict.

{{SUMMARY}}
