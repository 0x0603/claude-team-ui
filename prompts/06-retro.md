<!-- Retro step in every work flow, after the merge. Variables: {{BASE}} {{SUMMARY}} -->
RETRO. The merge checkpoint is passed; the pull request may still get comments, which come back as a new round and
a new retro. The goal: the team is never told the same thing twice.

Ask any teammates still alive to shut down. The lead does this alone, no teammates. Read only what you need:
plans/review.md and plans/review-*.md (earlier review rounds), plans/standards.md, plans/pr-comments.md and
plans/pr-replies.md (the pull request's reviewers, people and bots, if any), plans/review-log.md (if any), and
git log {{BASE}}..HEAD.

1. If plans/retro.md exists, an earlier retro already handled the problems it lists: move it to plans/retro-<N>.md
   (N = 1, 2, ...) and leave those problems out. List every other problem found after the build: fixed by the Standards
   step, raised by the reviewers, raised on the PR.
2. For each, pick the cheapest place that stops it next time:
   - An automated check: a lint rule, a stricter type, a test. It runs on every commit for free. Do not change code;
     list it under "Checks to add".
   - A rule in plans/coding-standards.md, when a reviewer can spot and fix it in a diff and it will come up again.
     If a rule already covered it, that rule failed: make it sharper instead of adding another.
   - Nowhere, when it was a one-off of this task.
3. Edit plans/coding-standards.md. It is a copy: I approve it before any later step uses it. At most 3 rules added or
   changed, each with "Why:" citing this PR or the finding. Delete rules that are outdated, or that a lint rule or the
   repo's own docs now cover. Keep the file under about 8 KB: every Standards and Review step reads it.
4. Write plans/retro.md:
   - Standards change: each rule added, changed or deleted, with its full new text and why
   - Checks to add
   - What cost time or quota for nothing in this flow
   - Lines in CLAUDE.md or AGENTS.md that are outdated (point them out; do not edit)
When it is done, start your reply with the line "RETRO DONE", then one line per standards change, or "No standards change".

{{SUMMARY}}
