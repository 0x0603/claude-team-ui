<!-- The pull request text, inserted into the work flows' review prompts as {{PRTEXT}}. Override per project in
<project>/.claude/team-ui/prompts/_pr.md. -->
The lead writes plans/pr.md, the pull request text, for a reviewer who has not seen this work:
- Line 1 is "# " and the title in the repo's commit convention.
- The body fills every section of the repo's PR template (.github/pull_request_template.md, if any) with real content:
  what changed and why, evidence with the exact commands run and their results, docs, the checklist ticked only where
  true, and follow-ups (minor findings, anything left for me). Keep "Closes #<issue>" when the task has an issue.
- Merge danger (in the template's risk section, or its own section): one-way or two-way door, as in plans/review.md;
  the blast radius (which packages, services, users or data the change reaches); for a one-way door, how to roll back.
- How it works: when the change moves control or data across more than one function, one Mermaid diagram in a
  ```mermaid block (a flowchart or a sequence diagram of the new flow), and a few lines of pseudocode for any logic that
  is not obvious from the diff. Skip both for docs-only or one-line changes.
Plain short sentences, no bold, the template's HTML comments removed, no tool or AI attribution.
