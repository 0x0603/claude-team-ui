<!-- Standards step in every work flow. Variables: {{RULES}} {{STRONG}} {{BASE}} {{TEST}} {{SUMMARY}} -->
STANDARDS step. The build is done and its tests pass; what it changed is staged, not committed. Someone who has not
seen the build now brings the diff up to the project's coding standards and fixes what they find, instead of leaving
comments.

{{RULES}}

I explicitly ask that the teammate does not commit: it stages its fixes, and the Commit step after the review commits.
Put this sentence in its spawn prompt.

Spawn 1 teammate "standards" (model {{STRONG}}). It:
- Reads plans/coding-standards.md first, and the repo docs it points to; then the diff (git diff --merge-base {{BASE}})
  and the plan (plans/plan.md or plans/final-plan.md) for intent. Scope: ONLY the files this work changed.
- Starts with the tests, before changing anything. If git diff --name-only or git ls-files --others --exclude-standard
  lists anything (changes not staged), it skips this check and says why in plans/standards.md. Otherwise, for each new
  or changed test file: copy the source file it tests aside, break that file once (one condition or one return value),
  run that test file, check that it fails, copy the original back, and check that git diff is empty again. A test that
  still passes is unfailable: rewrite it to assert behaviour, or delete it when it only restates the code. Then it
  checks every new test against the Tests section of plans/coding-standards.md.
- Fixes every violation of plans/coding-standards.md in the diff, and simplifies without changing behaviour: merge
  duplicates, drop dead code, flatten nested ifs, inline abstractions used once, reuse what the repo already has.
- Never changes behaviour or a public API, and never weakens a test to make it pass. Anything that would, it reports to
  the lead as a finding for Review.
- One small change at a time → run the tests for it → keep it if they pass, revert it at once if they fail
  (git checkout -- <file> brings back the staged version). At the end, it stages the changed files by name and does
  not commit.
- Writes plans/standards.md: each fix (rule number or "simplify", file:line, why in one line), the result of the
  break-the-code check for each test file, and what it left for Review.
When it is done, start your reply with the line "STANDARDS DONE", then the number of fixes and of lines removed.

{{SUMMARY}}
