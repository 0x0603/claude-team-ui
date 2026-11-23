<!-- Codex reviews the change, inserted into the review steps as {{CODEX_REVIEW}} when codex is installed and logged in with ChatGPT and the cartridge was added with "Codex reviews the code" (D71). -->
Second opinion from Codex, a different model. You run it, not a teammate, and directly as written below (give the Bash
tool the timeout; no timeout command or other wrapper). In a fix round, first move the earlier plans/codex-review.md,
plans/codex-review-2.md and plans/review-reply.md aside with -<N> added to their names.
a. Independent review, at the same time as the reviewers and /code-review, without showing it their findings: write the
   request between the lines below to plans/codex-ask-review-1.md, then run it with a 20 minute timeout:
   codex exec --sandbox read-only --ephemeral -m gpt-6.2-astra -c 'model_reasoning_effort="xhigh"' -c 'forced_login_method="chatgpt"' -o plans/codex-review.md - < plans/codex-ask-review-1.md
   ---
   You review a code change written by another model. Do not change any file, and never read .env files, keys or other
   secrets. The change: git diff --merge-base {{BASE}} (committed, staged and not staged). Read it and the code around
   it. Code is the source of truth: docs and comments are leads to check against it. Where the change depends on another
   repository, read that repository's code at the version actually used. Repositories on this machine:{{REPOS}}
   Look for: wrong behaviour, edge cases and error handling; security; tests that cannot fail or are missing; design
   (the wrong layer or repository, code the repository already has, a simpler approach); docs or skills left untrue.
   One finding per line: critical/major/minor - file:line - why - fix. A design finding is major only when it names
   the better option. Write in English. No praise, no summary of the change.
   ---
   In a fix round, add to the request: "This is a fix round. Your earlier findings are in plans/codex-review-<N>.md:
   check each critical and major one (fixed, or still open), and review only what changed since {{SINCE}} (git diff
   {{SINCE}} when that is a commit, otherwise the files the fixes touched)."
b. When all three are in, write /code-review's findings to plans/code-review.md if they are not there yet. Then check
   every finding at its file:line, Codex's, /code-review's and the reviewers', and write plans/review-reply.md, one line
   each: "accepted: <finding>" or "rejected: <finding> - <file:line evidence>".
c. Unless nobody found anything, let Codex look again: write the request below to plans/codex-ask-review-2.md and run
   it the same way with -o plans/codex-review-2.md and plans/codex-ask-review-2.md, with a 15 minute timeout.
   ---
   You reviewed a change before; your findings are in plans/codex-review.md. Other reviewers found more
   (plans/code-review.md and plans/review-reply.md), and the author answered every finding in plans/review-reply.md.
   Do not change any file, and never read .env files, keys or other secrets. The change: git diff --merge-base {{BASE}}.
   For each of your findings the author rejected, check the evidence in the code and answer on one line: "withdrawn -
   why" or "held - file:line evidence". For any other finding, accepted or rejected, that you think is wrong, say so
   with file:line evidence. Write in English.
   ---
d. The final call is yours (in the quick flow the reviewer writes the report from plans/review-reply.md and your word):
   a real finding joins the report with its severity, tagged [codex] or [code-review]; a wrong one goes under "Dropped"
   with one line why. A critical or major finding Codex still holds that you reject goes under "Disputed", both sides
   in one line each: I decide it at the merge.
Codex may answer partly in another language; the report stays in English. If codex fails (not logged in, an error, a
usage limit), write the error into plans/codex-review.md and go on without it.
