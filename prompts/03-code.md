<!-- Build phase. Variables: {{RULES}} {{CHECKS}} {{STRONG}} {{FAST}} {{TEST}} {{BRANCH}} {{SUMMARY}} -->
BUILD phase on branch {{BRANCH}}. Follow plans/tasks/INDEX.md and the plans/tasks/T*.md files. Code is unlocked now.

{{RULES}}

{{CHECKS}}

I explicitly ask for one commit for the whole build, made by the lead at the end. Put this sentence in every developer's
spawn prompt: "The user asked for one commit at the end: do not commit, the lead commits."

Spawn at most 2 developers "dev-1", "dev-2" (model {{FAST}}) and 1 "reviewer" (model {{STRONG}}, read only).
Use the second developer only for tasks INDEX.md marks as parallel. Track tasks from INDEX.md (shared task list if you
have one, otherwise plans/status.md), keeping the dependencies.
If plans/review.md lists work to redo, this is a fix round: redo only those tasks.

Rules for developers:
- Take ONE task at a time and read only its file plans/tasks/Txx.md, not the whole plan.
- Change only the files the task allows. Anything else: message the lead, do not do it yourself.
- Write the tests, docs and skill updates the task owns, as part of the task.
- Run the test command from "Done when" (default {{TEST}}). The task is done only when it passes. A failure in a file
  you did not touch goes to the lead; another developer may be mid-change.
- Do not commit. When a task is done and its test passes, tell the lead which files it changed. The developers share
  one folder: never git add -A, git add . or git commit -a, and never undo another developer's changes. Never push.
- At most 3 attempts; before each retry, write down what was wrong and the ONE change that should fix it. Still stuck: tell the lead.
Keep context small: the lead shuts each developer down after at most 3 tasks and spawns a fresh one with the same name
for the next task (the new one reads only its own task file).

Reviewer: reviews each task as soon as its developer reports it (git diff -- <its files>), messages the developer
directly about problems, and keeps plans/review-log.md.
Lead: does NOT code. Coordinates and updates plans/status.md after every task (done, who is on what, who is stuck).
When every task is done, the lead stages the changed files by name and makes the one commit, following the project's
commit convention (CLAUDE.md, CONTRIBUTING); in a fix round, git commit --amend --no-edit. Then start your reply with
the line "BUILD DONE".

{{SUMMARY}}
