<!-- Standard flow, step 2. Variables: {{RULES}} {{CHECKS}} {{FAST}} {{TEST}} {{BRANCH}} {{SUMMARY}} -->
STANDARD BUILD on branch {{BRANCH}}. I approved plans/plan.md. Code is unlocked now.

{{RULES}}

{{CHECKS}}

I explicitly ask for one commit for the whole change, made by the lead at the end. Put the team rules, the quality checks
and this sentence in every developer's spawn prompt: "The user asked for one commit at the end: do not commit, the lead commits."
Spawn "dev-1" (model {{FAST}}), and "dev-2" only for steps plans/plan.md marks as parallel. Each developer:
- Takes one step at a time and changes only the files that step lists; anything else, it asks the lead first.
- Writes the tests, docs and skill updates the step needs, as part of the step, not afterwards.
- Runs the tests for what it changed. A failure in a file it did not touch goes to the lead.
- Does not commit; when a step is done, tells the lead which files it changed. The developers share one folder: never
  git add -A, git add . or git commit -a, and never undo another developer's changes.
- After 3 failed attempts at the same problem, reports to the lead.
If plans/review.md exists, this is a fix round: fix only what it lists as needing work.

The lead does not code. It checks each finished step (git diff) against the plan and keeps plans/status.md short.
When every step is done, it stages the changed files by name and makes the one commit, following the project's commit
convention (CLAUDE.md, CONTRIBUTING); in a fix round, git commit --amend --no-edit. Never pushes.
When the commit is made, start your reply with the line "BUILD DONE", then the commit.

{{SUMMARY}}
