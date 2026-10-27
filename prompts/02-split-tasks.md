<!-- Split the plan into task files. Variables: {{RULES}} {{STRONG}} {{TEST}} -->
I approved the plan in plans/final-plan.md. Do not change code yet.

{{RULES}}

Spawn 1 teammate "splitter" (model {{STRONG}}) to cut the plan into task files:
- One file per task, plans/tasks/T01.md, T02.md, ... in the order they will be done.
- Each file is SELF-CONTAINED, so whoever does it never needs the whole plan:
  1. Goal of the task (1-2 sentences) and why it is needed (the key point from the spec)
  2. Files it may change (an explicit list); nothing else gets touched
  3. Code context needed (file:line, related interfaces and contracts)
  4. Steps, including the tests, docs and skill updates this task owns
  5. Done when: the exact test command that must pass (default {{TEST}}) and the behaviour to observe
  6. Dependencies: which tasks must be finished first
- Check every task: specific, checkable without a human judging, clear scope, clear output. Split any task that fails.
- Two tasks that can run in parallel must NOT change the same file.
- Write plans/tasks/INDEX.md: a table of tasks, dependencies, and the groups that can run in parallel.

When it is done, tell me "TASKS DONE" with the number of tasks and the parallel groups.
