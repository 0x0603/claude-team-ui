<!-- Codex reviews the final plan, inserted into the plan steps as {{CODEX_PLAN}} when codex is installed and logged in with ChatGPT (D71). -->
Second opinion from Codex, a different model. You run it, not a teammate, and directly as written below (give the Bash
tool the timeout; no timeout command or other wrapper). When the plan is final, before your DONE line:
1. Write the request between the lines below to plans/codex-ask-1.md, then run it with a 15 minute timeout:
   codex exec --sandbox read-only --ephemeral -c 'forced_login_method="chatgpt"' -o plans/codex-plan-1.md - < plans/codex-ask-1.md
   ---
   You review a software plan written by another model. Do not change any file, and never read .env files, keys or
   other secrets.
   Read {{PLANFILE}}, plans/coding-standards.md and the code the plan touches. Code is the source of truth: docs and
   comments are leads to check against it. Where the plan depends on another repository, read that repository's code
   at the version actually used. Repositories on this machine:{{REPOS}}
   Judge the approach first: the right layer and repository, a fit with the architecture and its patterns, a simpler
   approach that meets the acceptance criteria. Then the gaps: wrong file:line, missing cases or error handling, tests
   that cannot fail, docs or skills left untrue, risks not named.
   One finding per line: critical/major/minor - file:line or plan section - why - proposal. A design finding is major
   only when it names the better option. Write in English. No praise, no summary of the plan.
   ---
2. Answer every finding in plans/codex-reply-1.md, one line each: "accepted: <what changed in the plan, where>" or
   "rejected: <file:line evidence>". Change the plan for each accepted one (in the standard flow, the planner does).
3. Only if you rejected a critical or major finding: write the request below to plans/codex-ask-2.md and run the same
   command with -o plans/codex-plan-2.md and plans/codex-ask-2.md.
   ---
   You reviewed this plan before. Your findings are in plans/codex-plan-1.md, the author's answers in
   plans/codex-reply-1.md, and the plan has been revised. Do not change any file or read secrets. For each finding the author
   rejected, check the evidence in the code and answer on one line: "withdrawn - why" or "held - file:line evidence".
   Write in English.
   ---
4. Each critical or major finding Codex still holds goes into the plan's open questions: the finding, Codex's evidence
   and yours, one line each. I decide.
If codex fails (not logged in, an error, a usage limit), write the error into plans/codex-plan-1.md and go on without it.
