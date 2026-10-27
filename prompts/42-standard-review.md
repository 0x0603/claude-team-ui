<!-- Standard flow, step 3. Variables: {{RULES}} {{CHECKS}} {{STRONG}} {{FAST}} {{BASE}} {{TEST}} {{SINCE}} {{SUMMARY}} -->
STANDARD REVIEW of everything this work changed (git diff {{BASE}}...HEAD), against plans/plan.md.

{{RULES}}

{{CHECKS}}

Spawn 2 teammates who REPORT ONLY and never change product code:
- "logic-security" ({{STRONG}}): checks 1 and 2.
- "tests-docs" ({{FAST}}): checks 3, 4 and 5; lists missing tests, docs and skill updates by file. It runs {{TEST}} only when
  no pre-commit hook already ran the suite on the commit; otherwise it runs the tests for what it questions.
Each finding: file:line - severity (critical/major/minor) - why - how to fix. Each reviewer reads the other's findings
and drops or confirms them.

If plans/review.md already exists, this is a fix round, not a fresh review: first move it to plans/review-<N>.md (N = 1 for
the first earlier round, then 2, ...). The reviewers then check each critical and major finding of that earlier round at
its file:line (fixed, or still open), and review only what changed since {{SINCE}} (git diff {{SINCE}}...HEAD when that is
a commit, otherwise the files the fixes touched). The verdict still covers the whole change.

The lead writes plans/review.md:
1. A table of the five checks: pass / fail, with the evidence
2. Findings by severity (in a fix round: each earlier finding with its status, then anything new)
3. Test result
4. Verdict: READY TO MERGE, or NEEDS WORK with the exact list of what to fix
The lead also writes plans/pr.md, the pull request text: line 1 is "# " and the title in the repo's commit
convention; then the body, filling every section of the repo's PR template (.github/pull_request_template.md, if
any) with real content: what changed and why, evidence with the exact commands run and their results, risk, docs,
the checklist ticked only where true, and follow-ups (minor findings, anything left for me). Keep "Closes #<issue>"
when the task has an issue. Plain short sentences, the template's HTML comments removed, no tool or AI attribution.
When it is done, start your reply with the line "REVIEW DONE", then the verdict.

{{SUMMARY}}
