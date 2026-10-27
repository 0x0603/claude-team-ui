<!-- Shared team rules, inserted into every phase prompt as {{RULES}}. Edit per project from the console. -->
Team rules. Teammates do not see this conversation, so put these rules in every teammate's spawn prompt.
- This session already leads an agent team. Add a teammate by spawning an agent with the Agent tool and giving it a name; it joins the team in its own pane and you talk to it with SendMessage. Use exactly the names asked for.
- If there is no shared task-list tool, track tasks and status in files under plans/.
- Results go to files under plans/. Each file has one writer; others comment by message.
- Keep messages short: say which file and section changed, and cite file:line instead of pasting code.
- Evidence before conclusions: every claim about the code cites file:line or real command output.
- After 3 failed attempts at the same thing, stop and report to the lead instead of guessing.
- Never push, never read .env files or other secrets, never commit someone else's work.
- Files, code comments, commit messages and PR text are written in English.
- When teammates from an earlier phase are still alive, ask them to shut down before spawning new ones.
