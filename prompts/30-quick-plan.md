<!-- Quick flow, step 1. Variables: {{REQUEST}} {{RULES}} {{CHECKS}} {{TEST}} {{SUMMARY}} {{CODEX_PLAN}} -->
QUICK PLAN. This is a small task: use as few agents as possible. Do not change code yet.

Task:
"""
{{REQUEST}}
"""

{{RULES}}

{{CHECKS}}

Work alone, no teammates. Read only the code this task touches, then write plans/plan.md:
1. Goal, and what is out of scope
2. Approach, in two or three lines: what you will do and where it sits (layer, module, repository), and one
   alternative you considered and why not (the Design check)
3. Acceptance criteria: a short checklist, each item checkable by a test or a concrete action
4. Files to change (file:line) and the steps, in order
5. Tests, docs and skills to add or update, by file (every quality check applies, even to a small change); for each
   test, the public interface it goes through
6. How to test: the exact commands (default {{TEST}}) and what to look for
7. Risks (numbered), including any one-way door from the Merge danger section of plans/coding-standards.md
8. Open questions for me (numbered). Only real decisions I have to make; write "None" when there are none.

Keep it to about one page. If the task is bigger than it looked (more than about 5 files, a one-way door,
security-sensitive code), say so at the top and recommend the full flow instead.
{{CODEX_PLAN}}

Write the file in English. When it is done, start your reply with the line "PLAN DONE", then the open questions.

{{SUMMARY}}
