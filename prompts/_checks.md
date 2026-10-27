<!-- Shared quality checks, inserted into build and review prompts as {{CHECKS}}. Edit per project from the console. -->
Quality checks. Every change is built for, and reviewed against, all five:
1. Logic: it does what the plan and the acceptance criteria say; edge cases, error handling, no regressions.
2. Security: input validation, auth and permissions, secrets, injection, risky dependencies.
3. Tests: new or changed behaviour has tests, edge cases included, and the full test command ({{TEST}}) passes.
4. Docs: every doc the change touches or makes untrue is updated: READMEs, docs pages, changesets, comments that state behaviour.
5. Skills: agent skills and instructions that describe the changed behaviour (packages/skills, .claude/skills, AGENTS.md,
   CLAUDE.md and the like) are updated, or confirmed still true.
When the repo has its own rules for docs or skills (AGENTS.md, CONTRIBUTING, a docs-review or add-docs skill), follow them.
