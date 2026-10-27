<!-- Simplify phase. Variables: {{RULES}} {{STRONG}} {{BASE}} {{TEST}} {{SUMMARY}} -->
SIMPLIFY phase. The feature works and the tests pass.

{{RULES}}

I explicitly ask that the simplifications go into the existing commit. Put this in the simplifier's spawn prompt.

Spawn 1 teammate "simplifier" (model {{STRONG}}):
- Scope: ONLY the files this work changed (git diff {{BASE}}...HEAD). Do not tidy the rest of the repo.
- Simplify without changing behaviour: merge duplicates, drop dead code, rename for clarity, flatten nested ifs,
  inline abstractions used once, replace hand-written code with helpers the repo already has.
- No public API changes. Never edit a test to make it pass.
- One small change at a time → run the tests for it → keep it if they pass, revert it at once if they fail. At the end,
  fold everything into the existing commit (git commit --amend --no-edit; a new commit only if a pull request exists).
- Write plans/simplify.md: each change, why, and lines removed.
When it is done, start your reply with the line "SIMPLIFY DONE", then the total lines removed.

{{SUMMARY}}
