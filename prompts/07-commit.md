<!-- Commit step in every work flow. Variables: {{RULES}} {{BASE}} {{TEST}} {{COMMIT}} -->
COMMIT step. The review is done. Make the one commit for this work now, so the repo's pre-commit hook runs its checks
once, on the whole change. Do it yourself, no teammates.

{{RULES}}

1. git status. Stage by name what this work changed and is not staged yet (the review's new tests, for example), and
   nothing else: never git add -A, git add . or git commit -a, and plans/ stays out. If nothing is changed or staged
   (an earlier step already committed it), skip to the last line.
2. Write the commit message to plans/commit-msg.txt in the project's commit convention (CLAUDE.md, CONTRIBUTING), from
   the plan and plans/review.md: what changed and why, no tool or AI attribution.
3. {{COMMIT}} Give the command a long timeout: the hook runs the repo's checks. When the hook does not run the tests,
   run {{TEST}} once before committing.
4. If the hook fails on a real failure (an assertion, a type error, lint), fix only that, run the tests for it, stage
   the fix and commit again, and list each fix in your reply. A fix that would change behaviour beyond what the hook
   reported goes back to me: reply BLOCKED. A hook that fails with no failing assertion is the machine: follow the
   team rule above.
Never push. When the commit is made, start your reply with the line "COMMIT DONE", then git log -1 --oneline.
