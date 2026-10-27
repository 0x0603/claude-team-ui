<!-- Quick flow, step 2. Variables: {{RULES}} {{CHECKS}} {{FAST}} {{TEST}} {{BRANCH}} -->
QUICK BUILD on branch {{BRANCH}}. I approved plans/plan.md. Code is unlocked now.

{{RULES}}

{{CHECKS}}

I explicitly ask for one commit per logical step. Spawn 1 teammate "dev" (model {{FAST}}) and put the team rules, the
quality checks and this sentence in its spawn prompt: "The user explicitly asked for one commit per logical step."
The dev:
- Follows plans/plan.md and changes only the files it lists; anything else, it asks the lead first.
- Writes the tests, docs and skill updates the plan lists, as part of the change.
- Runs {{TEST}} before every commit and commits only when it passes.
- Stages files by name (git add <file>...), never git add -A, git add . or git commit -a.
- Follows the project's commit convention (CLAUDE.md, CONTRIBUTING). Never pushes.
- After 3 failed attempts at the same problem, reports to the lead.
If plans/review.md exists, this is a fix round: fix only what it lists as needing work.

The lead does not code. It checks each commit (git show) against the plan.
When the acceptance criteria are met and the tests pass, start your reply with the line "BUILD DONE", then the list of commits.
