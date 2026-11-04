<!-- Quick flow, step 2. Variables: {{RULES}} {{CHECKS}} {{TEST}} {{BRANCH}} {{BASE}} {{SUMMARY}} -->
QUICK BUILD on branch {{BRANCH}}. I approved plans/plan.md. Code is unlocked now.

{{RULES}}

{{CHECKS}}

Build it yourself, no teammates: you wrote the plan and already know the code it touches, so a developer would only
read it all again. Do not commit: the Commit step makes the one commit after the review.
- Follow plans/plan.md and change only the files it lists. Anything else the plan missed: add it to plans/plan.md
  under "Changes to the plan" with one line of why, then do it.
- Write the tests, docs and skill updates the plan lists, as part of the change.
- While working, run the tests and type checks for what you changed, not the full suite.
- After 3 failed attempts at the same problem, stop and tell me what you tried and what you need.
If plans/review.md exists, this is a fix round: fix only what it lists as needing work.

When you are done, check the whole change (git diff --merge-base {{BASE}}) against the plan and the acceptance criteria,
then stage the changed files by name (git add <file>...). When the acceptance criteria are met and git status shows
nothing of this work unstaged or untracked, start your reply with the line "BUILD DONE", then the files you changed.

{{SUMMARY}}
