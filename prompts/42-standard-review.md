<!-- Standard flow, step 3. Variables: {{RULES}} {{CHECKS}} {{STRONG}} {{FAST}} {{BASE}} {{TEST}} -->
STANDARD REVIEW of everything this work changed (git diff {{BASE}}...HEAD), against plans/plan.md.

{{RULES}}

{{CHECKS}}

Spawn 2 teammates who REPORT ONLY and never change product code:
- "logic-security" ({{STRONG}}): checks 1 and 2.
- "tests-docs" ({{FAST}}): checks 3, 4 and 5; runs {{TEST}}; lists missing tests, docs and skill updates by file.
Each finding: file:line - severity (critical/major/minor) - why - how to fix. Each reviewer reads the other's findings
and drops or confirms them.

The lead writes plans/review.md:
1. A table of the five checks: pass / fail, with the evidence
2. Findings by severity
3. Test result
4. Verdict: READY TO MERGE, or NEEDS WORK with the exact list of what to fix
When it is done, start your reply with the line "REVIEW DONE", then the verdict.
