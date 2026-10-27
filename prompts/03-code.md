<!-- Build phase. Variables: {{RULES}} {{STRONG}} {{FAST}} {{TEST}} {{BRANCH}} -->
BUILD phase on branch {{BRANCH}}. Follow plans/tasks/INDEX.md and the plans/tasks/T*.md files. Code is unlocked now.

{{RULES}}

I explicitly ask for one commit per finished task. Put this sentence in every developer's spawn prompt:
"The user explicitly asked for one commit per finished task."

Spawn at most 3 developers "dev-1", "dev-2", "dev-3" (model {{FAST}}) and 1 "reviewer" (model {{STRONG}}, read only).
Track tasks from INDEX.md (shared task list if you have one, otherwise plans/status.md), keeping the dependencies.

Rules for developers:
- Take ONE task at a time and read only its file plans/tasks/Txx.md, not the whole plan.
- Change only the files the task allows. Anything else: message the lead, do not do it yourself.
- Run the test command from "Done when" (default {{TEST}}). The task is done only when it passes.
- Each finished task is 1 commit. Follow the project's commit convention (CLAUDE.md, CONTRIBUTING); if there is none,
  use "Txx: <summary>". Never push.
- At most 3 attempts; before each retry, write down what was wrong and the ONE change that should fix it. Still stuck: tell the lead.
Keep context small: the lead shuts each developer down after at most 3 tasks and spawns a fresh one with the same name
for the next task (the new one reads only its own task file).

Reviewer: reviews each commit as soon as it lands (git show), messages the developer directly about problems, and
keeps plans/review-log.md.
Lead: does NOT code. Coordinates and updates plans/status.md after every task (done, who is on what, who is stuck).
When every task is done and the full test suite passes, tell me "BUILD DONE".
