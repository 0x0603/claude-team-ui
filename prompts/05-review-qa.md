<!-- Review + QA phase. Variables: {{RULES}} {{STRONG}} {{FAST}} {{BASE}} {{TEST}} -->
REVIEW + QA phase for everything this work changed (git diff {{BASE}}...HEAD), checked against plans/00-spec.md.

{{RULES}}

Spawn 4 teammates who REPORT ONLY and never fix product code:
- "security" ({{STRONG}}): auth, authorization, injection, leaked secrets, input validation
- "logic" ({{STRONG}}): behaviour that differs from the spec, edge cases, error handling, race conditions
- "test-writer" ({{FAST}}): writes tests for missing acceptance criteria and edge cases, ONLY in test folders
- "breaker" ({{FAST}}): tries to break the feature and writes exact reproduction commands

Each finding: file:line - severity (critical/major/minor) - why - how to fix - reproduction command if any.
Cross-check: drop any finding another reviewer proves wrong.
The lead writes plans/review.md:
1. The spec's acceptance criteria: met / not met (with evidence)
2. Findings by severity (keep only those confirmed by at least one other reviewer)
3. Result of the full test run ({{TEST}})
4. Verdict: READY TO MERGE or NEEDS WORK (list the tasks to redo)
When it is done, tell me "REVIEW DONE" with the verdict.
