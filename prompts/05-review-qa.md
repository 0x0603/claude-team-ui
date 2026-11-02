<!-- Review + QA phase. Variables: {{RULES}} {{CHECKS}} {{STRONG}} {{FAST}} {{BASE}} {{TEST}} {{SINCE}} {{PRTEXT}} {{SUMMARY}} -->
REVIEW + QA phase for everything this work changed (git diff {{BASE}}...HEAD), checked against plans/00-spec.md.

{{RULES}}

{{CHECKS}}

Spawn 5 teammates who REPORT ONLY and never fix product code:
- "security" ({{STRONG}}): auth, authorization, injection, leaked secrets, input validation
- "logic" ({{STRONG}}): behaviour that differs from the spec, edge cases, error handling, race conditions
- "test-writer" ({{FAST}}): writes tests for missing acceptance criteria and edge cases, ONLY in test folders
- "breaker" ({{FAST}}): tries to break the feature and writes exact reproduction commands
- "docs" ({{FAST}}): checks 4 and 5: docs and skills the change touches or makes untrue, by file

Each finding: file:line - severity (critical/major/minor) - why - how to fix - reproduction command if any.
Cross-check: drop any finding another reviewer proves wrong.
The Standards step already fixed the diff against plans/coding-standards.md (plans/standards.md lists what it
fixed and what it left for review): report a standards problem only if it is still in the diff.

If plans/review.md already exists, this is a fix round, not a fresh review: first move it to plans/review-<N>.md (N = 1 for
the first earlier round, then 2, ...). The reviewers then check each critical and major finding of that earlier round at
its file:line (fixed, or still open), and review only what changed since {{SINCE}} (git diff {{SINCE}} HEAD when that is
a commit, otherwise the files the fixes touched). The verdict still covers the whole change.

The lead writes plans/review.md. Its first line is "Merge danger: one-way door - <why>" or
"Merge danger: two-way door - <why>", judged from the diff against the Merge danger section of
plans/coding-standards.md. Then:
1. A table of the five quality checks: pass / fail (with evidence), and the spec's acceptance criteria: met / not met
2. Findings by severity (keep only those confirmed by at least one other reviewer; in a fix round: each earlier finding
   with its status, then anything new)
3. Result of the full test run ({{TEST}})
4. Verdict: READY TO MERGE or NEEDS WORK (list the tasks to redo)
{{PRTEXT}}
When it is done, start your reply with the line "REVIEW DONE", then the verdict.

{{SUMMARY}}
