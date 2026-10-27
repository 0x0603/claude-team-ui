<!-- Review + QA phase. Variables: {{RULES}} {{CHECKS}} {{STRONG}} {{FAST}} {{BASE}} {{TEST}} -->
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
The lead writes plans/review.md:
1. A table of the five quality checks: pass / fail (with evidence), and the spec's acceptance criteria: met / not met
2. Findings by severity (keep only those confirmed by at least one other reviewer)
3. Result of the full test run ({{TEST}})
4. Verdict: READY TO MERGE or NEEDS WORK (list the tasks to redo)
The lead also writes plans/pr.md, the pull request text: line 1 is "# " and the title in the repo's commit
convention; then the body, filling every section of the repo's PR template (.github/pull_request_template.md, if
any) with real content: what changed and why, evidence with the exact commands run and their results, risk, docs,
the checklist ticked only where true, and follow-ups (minor findings, anything left for me). Keep "Closes #<issue>"
when the task has an issue. Plain short sentences, the template's HTML comments removed, no tool or AI attribution.
When it is done, start your reply with the line "REVIEW DONE", then the verdict.
