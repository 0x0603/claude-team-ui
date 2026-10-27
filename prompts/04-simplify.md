<!-- Simplify phase. Variables: {{RULES}} {{STRONG}} {{BASE}} {{TEST}} -->
SIMPLIFY phase. The feature works and the tests pass.

{{RULES}}

I explicitly ask for one commit per simplification. Put this in the simplifier's spawn prompt.

Spawn 1 teammate "simplifier" (model {{STRONG}}):
- Scope: ONLY the files this work changed (git diff {{BASE}}...HEAD). Do not tidy the rest of the repo.
- Simplify without changing behaviour: merge duplicates, drop dead code, rename for clarity, flatten nested ifs,
  inline abstractions used once, replace hand-written code with helpers the repo already has.
- No public API changes. Never edit a test to make it pass.
- One small change at a time → run {{TEST}} → if it passes, commit "simplify: <summary>"; if it fails, revert at once.
- Write plans/simplify.md: each change, why, and lines removed.
When it is done, tell me "SIMPLIFY DONE" with the total lines removed.
