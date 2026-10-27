<!-- Quick flow, step 3. Variables: {{RULES}} {{CHECKS}} {{STRONG}} {{BASE}} {{TEST}} {{SINCE}} -->
QUICK REVIEW of everything this work changed (git diff {{BASE}}...HEAD), checked against plans/plan.md.

{{RULES}}

{{CHECKS}}

Spawn 1 teammate "reviewer" (model {{STRONG}}). It is read only: it never changes product code. It goes through all
five quality checks, and also flags code that should reuse what the repo already has.
Each finding: file:line - severity (critical/major/minor) - why - how to fix. Tests: when the repo's pre-commit hook runs
the suite, the commit only exists because it passed, so run just the tests for what you question; otherwise run {{TEST}} once.

If plans/review.md already exists, this is a fix round, not a fresh review: first move it to plans/review-<N>.md (N = 1 for
the first earlier round, then 2, ...). The reviewer then checks each critical and major finding of that earlier round at
its file:line (fixed, or still open), and reviews only what changed since {{SINCE}} (git diff {{SINCE}}...HEAD when that is
a commit, otherwise the files the fixes touched). The verdict still covers the whole change.

The reviewer writes plans/review.md: a table of the five checks (pass / fail, with evidence), acceptance criteria met or
not, findings by severity (in a fix round: each earlier finding with its status, then anything new), the test result,
and a verdict. READY TO MERGE when nothing critical or major is left: minor findings go under "Follow-ups" and do not
block. NEEDS WORK only for critical or major findings, with exactly what to fix.
The lead also writes plans/pr.md, the pull request text: line 1 is "# " and the title in the repo's commit
convention; then the body, filling every section of the repo's PR template (.github/pull_request_template.md, if
any) with real content: what changed and why, evidence with the exact commands run and their results, risk, docs,
the checklist ticked only where true, and follow-ups (minor findings, anything left for me). Keep "Closes #<issue>"
when the task has an issue. Plain short sentences, the template's HTML comments removed, no tool or AI attribution.
When it is done, start your reply with the line "REVIEW DONE", then the verdict.
