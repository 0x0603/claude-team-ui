<!-- Quick flow, step 3. Variables: {{RULES}} {{CHECKS}} {{STRONG}} {{BASE}} {{TEST}} {{SINCE}} {{PRTEXT}} {{SUMMARY}} -->
QUICK REVIEW of everything this work changed, checked against plans/plan.md. The newest part is staged, not committed
(the Commit step comes after this review): git diff --merge-base {{BASE}} shows all of it, committed or not (git status
for files not staged).

{{RULES}}

{{CHECKS}}

Spawn 1 teammate "reviewer" (model {{STRONG}}). It is read only: it never changes product code. It goes through all
five quality checks, and also flags code that should reuse what the repo already has.
The Standards step already fixed the diff against plans/coding-standards.md (plans/standards.md lists what it
fixed and what it left for review): report a standards problem only if it is still in the diff.
Each finding: file:line - severity (critical/major/minor) - why - how to fix. Tests: run the tests of the packages the
change touches and the tests for what you question; the full suite runs once, at the Commit step.

If plans/review.md already exists, this is a fix round, not a fresh review: first move it to plans/review-<N>.md (N = 1 for
the first earlier round, then 2, ...). The reviewer then checks each critical and major finding of that earlier round at
its file:line (fixed, or still open), and reviews only what changed since {{SINCE}} (git diff {{SINCE}} when that is
a commit, otherwise the files the fixes touched). The verdict still covers the whole change.

The reviewer writes plans/review.md. Its first line is "Merge danger: one-way door - <why>" or
"Merge danger: two-way door - <why>", judged from the diff against the Merge danger section of
plans/coding-standards.md. Then a table of the five checks (pass / fail, with evidence), acceptance criteria met or
not, findings by severity (in a fix round: each earlier finding with its status, then anything new), the test result,
and a verdict. READY TO MERGE when nothing critical or major is left: minor findings go under "Follow-ups" and do not
block. NEEDS WORK only for critical or major findings, with exactly what to fix.
{{PRTEXT}}
When it is done, start your reply with the line "REVIEW DONE", then the verdict.

{{SUMMARY}}
