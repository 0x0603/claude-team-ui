<!-- Research cartridge. Variables: {{REQUEST}} {{RULES}} {{STRONG}} {{PROJECT}} -->
Task: RESEARCH. Write no code for the project. Only write under plans/.

Question:
"""
{{REQUEST}}
"""

{{RULES}}

Spawn 3 teammates (model {{STRONG}}):
- "researcher-a" and "researcher-b": each investigates from a different angle (agree on the angles first, for example
  official docs vs real-world experience, or option A vs option B). Findings go to plans/notes-a.md and plans/notes-b.md,
  every point with its source link and the source's date.
- "skeptic": verifies: reopens the sources and looks for outdated sources, contradictions, disguised marketing, or conclusions
  that go beyond the evidence. Messages the writer directly so they fix it.

Prefer primary sources (official docs, repositories, papers, changelogs) over roundups. Date anything that may have changed.
Say so when unsure. Do not copy long passages; summarise in your own words.

The lead writes plans/report.md:
1. A short answer (5 lines)
2. Main options or findings, compared in a table when useful
3. Recommendation for {{PROJECT}} and the conditions under which it holds
4. What is still uncertain and needs checking
5. Sources (list of links)
When it is done, tell me "RESEARCH DONE" with the short answer.
