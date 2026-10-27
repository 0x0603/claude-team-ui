<!-- Quick flow, step 1. Variables: {{REQUEST}} {{CHECKS}} {{TEST}} -->
QUICK PLAN. This is a small task: use as few agents as possible. Do not change code yet.

Task:
"""
{{REQUEST}}
"""

{{CHECKS}}

Work alone, no teammates. Read only the code this task touches, then write plans/plan.md:
1. Goal, and what is out of scope
2. Acceptance criteria: a short checklist, each item checkable by a test or a concrete action
3. Files to change (file:line) and the steps, in order
4. Tests, docs and skills to add or update, by file (all five quality checks apply, even to a small change)
5. How to test: the exact commands (default {{TEST}}) and what to look for
6. Risks and open questions for me (numbered)

Keep it to about one page. If the task is bigger than it looked (more than about 5 files, schema or public API changes,
security-sensitive code), say so at the top and recommend the full flow instead.
Write the file in English. When it is done, tell me "PLAN DONE" with the open questions.
