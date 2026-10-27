<!-- Phase 0. Variables: {{REQUEST}} {{RULES}} {{STRONG}} -->
SPEC phase. Goal: understand the request before anyone discusses how to build it. No plan yet and no code changes.

My request:
"""
{{REQUEST}}
"""

{{RULES}}

Spawn 2 teammates (model {{STRONG}}), named exactly:
- "analyst": reads the relevant code (read only) and drafts plans/00-spec.md.
- "skeptic": reads the draft and looks for ambiguity, hidden assumptions and edge cases nobody mentioned, then messages the analyst directly.

Template for plans/00-spec.md:
1. Context: the current problem and who it affects (cite file:line where code is involved)
2. Goals (measurable)
3. Out of scope
4. Acceptance criteria: bullets, each one checkable by a test or a concrete action
5. Constraints: technical, performance, security, backward compatibility
6. Open questions for me (numbered)

The lead coordinates and does not write the spec; the analyst is the only writer of plans/00-spec.md.
When it is done, start your reply with the line "SPEC DONE", then the 3 most important open questions.
