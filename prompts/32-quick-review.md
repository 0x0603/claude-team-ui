<!-- Quick flow, step 3. Variables: {{RULES}} {{CHECKS}} {{STRONG}} {{BASE}} {{TEST}} -->
QUICK REVIEW of everything this work changed (git diff {{BASE}}...HEAD), checked against plans/plan.md.

{{RULES}}

{{CHECKS}}

Spawn 1 teammate "reviewer" (model {{STRONG}}). It is read only: it never changes product code. It goes through all
five quality checks, and also flags code that should reuse what the repo already has.
Each finding: file:line - severity (critical/major/minor) - why - how to fix. It also runs {{TEST}}.

The reviewer writes plans/review.md: a table of the five checks (pass / fail, with evidence), acceptance criteria met or
not, findings by severity, the test result, and a verdict: READY TO MERGE or NEEDS WORK (with what to fix).
When it is done, start your reply with the line "REVIEW DONE", then the verdict.
