<!-- Standard flow, step 2. Variables: {{RULES}} {{CHECKS}} {{FAST}} {{TEST}} {{BRANCH}} -->
STANDARD BUILD on branch {{BRANCH}}. I approved plans/plan.md. Code is unlocked now.

{{RULES}}

{{CHECKS}}

I explicitly ask for one commit per finished step. Put the team rules, the quality checks and this sentence in every
developer's spawn prompt: "The user explicitly asked for one commit per finished step."
Spawn "dev-1" (model {{FAST}}), and "dev-2" only for steps plans/plan.md marks as parallel. Each developer:
- Takes one step at a time and changes only the files that step lists; anything else, it asks the lead first.
- Writes the tests, docs and skill updates the step needs, as part of the step, not afterwards.
- Runs {{TEST}} before every commit and commits only when it passes. A failure in a file it did not touch goes to the lead.
- Stages files by name (git add <file>...), never git add -A, git add . or git commit -a; the developers share one folder.
- Follows the project's commit convention (CLAUDE.md, CONTRIBUTING). Never pushes.
- After 3 failed attempts at the same problem, reports to the lead.
If plans/review.md exists, this is a fix round: fix only what it lists as needing work.

The lead does not code. It checks each commit (git show) against the plan and keeps plans/status.md short.
When every step is done and the tests pass, tell me "BUILD DONE" with the list of commits.
