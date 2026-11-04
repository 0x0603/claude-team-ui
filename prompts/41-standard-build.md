<!-- Standard flow, step 2. Variables: {{RULES}} {{CHECKS}} {{FAST}} {{TEST}} {{BRANCH}} {{BASE}} {{SUMMARY}} -->
STANDARD BUILD on branch {{BRANCH}}. I approved plans/plan.md. Code is unlocked now.

{{RULES}}

{{CHECKS}}

Nobody commits in this step: the Commit step makes the one commit after the review. Put the team rules, the quality
checks and this sentence in every developer's spawn prompt: "Do not commit or stage: the lead stages, and commits at the end."
Spawn "dev-1" (model {{FAST}}), and "dev-2" only for steps plans/plan.md marks as parallel. Each developer:
- Takes one step at a time and changes only the files that step lists; anything else, it asks the lead first.
- Writes the tests, docs and skill updates the step needs, as part of the step, not afterwards.
- Runs the tests and type checks for what it changed, not the full suite. A failure in a file it did not touch goes
  to the lead.
- Does not commit or stage; when a step is done, tells the lead which files it changed. The developers share one
  folder: never git add -A, git add . or git commit -a, and never undo another developer's changes.
- After 3 failed attempts at the same problem, reports to the lead.
If plans/review.md exists, this is a fix round: fix only what it lists as needing work.

The lead does not code. It checks each finished step (git diff -- <its files>) against the plan, stages its files by
name (git add <file>...) and keeps plans/status.md short. When every step is done, it checks the whole change
(git diff --merge-base {{BASE}}) against the plan, and git status shows nothing of this work unstaged or untracked.
Then start your reply with the line "BUILD DONE", then the files changed.

{{SUMMARY}}
