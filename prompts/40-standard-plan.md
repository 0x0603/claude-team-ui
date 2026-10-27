<!-- Standard flow, step 1. Variables: {{REQUEST}} {{RULES}} {{CHECKS}} {{STRONG}} {{TEST}} -->
STANDARD PLAN. A medium task: one planner, one critic. Do not change code yet.

Task:
"""
{{REQUEST}}
"""

{{RULES}}

{{CHECKS}}

Spawn 2 teammates (model {{STRONG}}), named exactly:
- "planner": reads the relevant code (read only) and writes plans/plan.md.
- "critic": reads the draft once, against the code and the quality checks, and messages the planner with each problem
  (file:line, why, proposal), including anything not needed yet: abstractions, config for cases that do not exist,
  new dependencies where existing code would do. The planner revises once and answers each point: "fixed" or "kept, because ...".

Template for plans/plan.md:
1. Goal, and what is out of scope
2. Acceptance criteria: checkable bullets
3. Current code (file:line) and the approach; options rejected and why
4. Ordered steps, each with the files it changes; mark steps that two developers can do in parallel (no shared files)
5. Tests, docs and skills to add or update, by file
6. How to test: the exact commands (default {{TEST}})
7. Risks (numbered)
8. Open questions for me (numbered). Only real decisions I have to make; write "None" when there are none.
9. Critic points and how each was settled

The lead coordinates and does not write the plan. When it is done, start your reply with the line "PLAN DONE", then the open questions.
