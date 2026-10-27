# Changelog

## 1.0.0 (2026-10-27)

Rewrite of the 0.4.0 handoff after checking it against real Claude Code 2.1.311 (`docs/verify.md`).

Fixed
- Planning lock: path deny rules also blocked `plans/`, so no team could write its spec or plan. Replaced by a `PreToolUse` hook.
- Soft stop: `/exit` with teammates alive opens a menu; the console now confirms it and waits for Claude to exit.
- Fork PR reviews: fetch `pull/<n>/head` instead of the head branch name.
- The trust dialog defaults to "No, exit"; the console recognises it and offers "Trust folder".
- Teammate panes are labelled from the team config (pane titles show the agent type).
- Agent messages come from transcripts (inboxes are emptied on delivery). The task board shows only when a task list exists.
- Project paths are resolved with realpath; teams are matched by folder, not by path encoding.
- tmux sessions get the cartridge id and Claude settings explicitly, whatever environment started the tmux server.

Added
- Several projects in one console, an overview screen, and projects and settings in the UI.
- Isolation: each team writes only inside its own cartridge; `.env` reads, `git push` and `rm -rf` are blocked.
- Plan usage (5-hour and 7-day) from the status line, and cost per cartridge from transcripts.
- Open PR from the merge checkpoint (push + draft PR, with the repo's PR template).
- Start options: permission mode, lead model, continue the last conversation.
- Node version per project from nvm (or the repo's `.nvmrc`), so hooks that need another Node pass.
- Branch name and base per cartridge; main-checkout cartridges; per-project prompt templates and team rules;
  teammate models as settings.
- Notebook archived on eject; `/plans/` and tool files kept out of git through `.git/info/exclude`.

Changed
- Everything in English: code, UI, prompts, docs. Prompts fit how agent teams work now (the team exists from the start;
  teammates are named agents).
- Backend split into `lib/` modules; phone layout first.

Removed
- `TaskCompleted` hook and the `CLAUDE.md` template written into projects; `MISSION.md`, `KICKOFF.md`, `run.sh`, `HANDOFF.md`.
