<!-- Review cartridge. Variables: {{REQUEST}} {{RULES}} {{STRONG}} {{TARGET}} {{BASE}} {{CHECKS}} {{SCOPE}} -->
Task: REVIEW code. Read only: do not change product code and do not commit.

{{REQUEST}}

This folder is a separate checkout made for reviewing. The console has already moved it to the latest commit of {{TARGET}}.
Scope: {{SCOPE}}
If plans/context/ exists, it holds the spec and plan of the work under review; read them to know the intent.

{{RULES}}

{{CHECKS}}

Spawn 3 teammates (model {{STRONG}}), all READ ONLY:
- "security": auth, authorization, injection, leaked secrets, input validation
- "logic": does it do what was asked, edge cases, error handling, race conditions, backward compatibility
- "quality": tests, docs and skills (checks 3 to 5), performance, dead or hard-to-maintain code, places that should reuse existing code
Each finding: file:line - severity (critical/major/minor) - why - how to fix - reproduction command if any.
Then cross-check: drop any finding another reviewer proves wrong. No generic praise.

The lead writes plans/review-report.md:
1. A 3-line summary, a table of the five quality checks (pass / fail), and a verdict: READY TO MERGE / NEEDS WORK / DO NOT MERGE
2. Findings by severity (keep only those confirmed by at least one other reviewer)
3. Result of the existing tests (only if they run without changing anything)
4. Questions for the author
When it is done, tell me "REVIEW DONE" with the verdict.
