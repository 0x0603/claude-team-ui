<!-- Shared summary, inserted into every step prompt as {{SUMMARY}}. Edit per project from the console. -->
Summary for the console. Before your final line, append a section to plans/summary.md (create the file if it is missing;
earlier sections stay as they are): a heading "## {{STEP}} — <YYYY-MM-DD HH:MM>", then these keys in this order, each on
its own line as "Key: value", plain facts and no praise:
Verdict: READY TO MERGE, NEEDS WORK, DONE or BLOCKED
Findings: N critical, N major, N minor (0 0 0 when there are none)
Acceptance: n/m met
Tests: pass or fail, and the command
Changed: files and commits, or none
Top: up to 3 sub-bullets "- file:line — one line": the findings or changes that matter most
Questions: numbered sub-bullets with what you need from me, or None
Decided for you: numbered sub-bullets for choices you made because I was away, or None
Next: one line on what happens next
