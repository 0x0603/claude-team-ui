<!-- Quick flow, step 2. Variables: {{RULES}} {{CHECKS}} {{TEST}} {{BRANCH}} {{SUMMARY}} -->
QUICK BUILD on branch {{BRANCH}}. I approved plans/plan.md. Code is unlocked now.

{{RULES}}

{{CHECKS}}

Build it yourself, no teammates: you wrote the plan and already know the code it touches, so a developer would only
read it all again. I explicitly ask for one commit for the whole change, made at the end.
- Follow plans/plan.md and change only the files it lists. Anything else the plan missed: add it to plans/plan.md
  under "Changes to the plan" with one line of why, then do it.
- Write the tests, docs and skill updates the plan lists, as part of the change.
- While working, run the tests for what you changed. Run the full test command ({{TEST}}) once before the commit,
  unless the pre-commit hook already runs it.
- After 3 failed attempts at the same problem, stop and tell me what you tried and what you need.
If plans/review.md exists, this is a fix round: fix only what it lists as needing work and fold the fixes into the commit.

Before committing, check the diff (git diff) against the plan and the acceptance criteria. Then stage the changed files by
name (git add <file>..., never git add -A, git add . or git commit -a) and make the one commit, following the project's
commit convention (CLAUDE.md, CONTRIBUTING); in a fix round, git commit --amend --no-edit. Never push.
When the acceptance criteria are met and the commit is made, start your reply with the line "BUILD DONE", then the commit.

{{SUMMARY}}
