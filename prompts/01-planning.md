<!-- Phases 1-6. Variables: {{RULES}} {{STRONG}} -->
PLANNING phase. I approved the spec in plans/00-spec.md; it is the source of truth, read it first.
The whole team only READS code. Every result goes to plans/. Messages only say "updated file X, section Y".

{{RULES}}

Spawn 5 teammates (model {{STRONG}}), named exactly:
- "scout": map of the relevant code → plans/01-code-map.md (modules, data flow, dependencies, existing tests, file:line).
  Only what the spec touches; skip node_modules, build output and generated files.
- "planner-a" and "planner-b": each writes an INDEPENDENT plan → plans/02-plan-a.md and plans/02-plan-b.md.
  Neither reads the other's plan before round 3.
- "critic": finds holes, risks and places where a plan does not match the code or the spec → plans/03-review.md (critic part).
- "simplifier": finds what is not needed yet (abstractions, config for cases that do not exist, new dependencies when
  existing code would do, steps that can merge) → plans/03-review.md (simplifier part). Prefers reusing existing code (cite file:line).

Rounds:
1. The scout writes the code map and tells the other four.
2. planner-a and planner-b write their plans from the template below.
3. Cross-review: planner-a reviews plan B, planner-b reviews plan A, critic and simplifier review both.
   Every point needs file:line or command output. "This might be a problem" is not accepted.
4. Both planners revise and answer each point: "agree, fixed" or "disagree, because ...".
5. Critic and simplifier check again. If a critical issue remains, go back to round 4, at most twice.
6. The lead merges the best of A and B into plans/final-plan.md and sends it to ALL teammates:
   scout: are the file:line references still right? · planners: was your idea merged correctly, do the steps conflict?
   critic: are all critical issues handled? · simplifier: did the final plan grow more than it needs?
   Each answers in exactly one form: "AGREE" or "OBJECT: <section> - <reason> - <proposal>".
   On objections the lead revises ONCE and sends it again; anything still open goes under "Unresolved", no more loops.

Plan template (02-plan-*.md and final-plan.md):
1. Goal and scope, including what is out of scope (follows plans/00-spec.md)
2. Current state of the relevant code (file:line)
3. Approach and why; options rejected and why
4. Ordered steps; each step: files to change, a checkable done criterion, dependencies
5. Test plan: new tests, tests that may break
6. Risks and how to roll back
7. Open questions for me
final-plan.md also has: 8. Debate log (who said what, how it was settled) · 9. Unresolved · 10. Round 6 results

The lead does not plan alone and waits for every round.
When it is done, tell me "PLAN DONE" with a 5-line summary and the decisions you need from me.
