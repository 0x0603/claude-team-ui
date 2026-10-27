<!-- Quick flow, step 2. Variables: {{RULES}} {{CHECKS}} {{FAST}} {{TEST}} {{BRANCH}} -->
QUICK BUILD on branch {{BRANCH}}. I approved plans/plan.md. Code is unlocked now.

{{RULES}}

{{CHECKS}}

I explicitly ask for one commit for the whole change, made by the lead at the end. Spawn 1 teammate "dev" (model {{FAST}})
and put the team rules, the quality checks and this sentence in its spawn prompt: "The user asked for one commit at
the end: do not commit, the lead commits."
The dev:
- Follows plans/plan.md and changes only the files it lists; anything else, it asks the lead first.
- Writes the tests, docs and skill updates the plan lists, as part of the change.
- While working, runs the tests for what it changed. When done, tells the lead which files it changed. It does not commit.
- After 3 failed attempts at the same problem, reports to the lead.
If plans/review.md exists, this is a fix round: fix only what it lists as needing work; the lead folds it into the commit.

The lead does not code. It gives the dev the whole plan at once and checks the diff (git diff) against it. Then it stages
the changed files by name (git add <file>..., never git add -A, git add . or git commit -a) and makes the one commit,
following the project's commit convention (CLAUDE.md, CONTRIBUTING); in a fix round, git commit --amend --no-edit. Never pushes.
When the acceptance criteria are met and the commit is made, start your reply with the line "BUILD DONE", then the commit.
