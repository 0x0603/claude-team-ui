# Changelog

## Unreleased

Changed
- Simplify becomes Standards and runs in every work flow, the quick flow included: a fresh teammate reads the project's
  coding standards, proves each new test can fail, fixes the diff and simplifies it (D58).
- Every work flow ends with Retro and "You approve the standards change": the checkpoint shows the exact diff the console
  read when the retro ended; Adopt saves exactly that, Keep the current standards drops it (D60).
- Fix-round reviews diff with `git diff <since> HEAD`: the three-dot form showed the whole change once the commit was amended. The full flow's retro no longer moves the notebook into `plans/archive/`.
- Reviews start their report with the merge danger (one-way or two-way door); the merge step and the home list show it.
- The PR text is one template, `prompts/_pr.md` (`{{PRTEXT}}`), and asks for the blast radius, a rollback plan for
  one-way doors and a Mermaid diagram.
- The assistant chat: the head has icon buttons (chats, new chat, close) clear of the grab handle; the composer is one
  field with the text at full width, growing to a third of the screen, and the model as a quiet chip next to Send under
  it. Answers show without a bubble, long pastes fold behind "Show all", and Copy is an icon that turns into a tick.
- The chat and terminal composers share that field; Send fades while there is nothing to send, and the assistant button
  steps aside while a message is being written.

Fixed
- Times older than a day read as a date, not "10/29/2026 ago".

Added
- `prompts/_standards.md`, editable per project from ⋯ → Edit coding standards and written to
  `plans/coding-standards.md` before each step (D59).

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
- Quick, Standard and Full flows, chosen per cartridge and switchable. Every flow builds and reviews logic, security,
  tests, docs and skills (`prompts/_checks.md`, editable per project).
- Fix loop: bugs found in Review + QA, or changes asked at the merge checkpoint, go back to the build.
- `bin/team-ui-config.js` exports and imports projects and settings with relative paths, to sync two machines.
- Hands-off autopilot (default): plan checkpoints pass by themselves, NEEDS WORK reviews loop back to Build, a waiting step runs once the lead is idle, the start-up trust question is answered. The merge still waits.
- Answering a permission prompt clears it at once; the terminal shows real colours and opens on the newest line.
- Glass navbar and dock over scrolling content, collapsing titles, sticky section headers, and short motion for navigation, sheets and toasts.
- Compact sheet buttons in one row.
- Home list shows what each team is doing: the lead's newest line, one orb per agent, steps done; plan usage as rings.
- Issue picker searches across all projects, defaults to issues assigned to you, and adds issues from several projects at once.
- Appearance: Auto, Light or Dark; black buttons, frosted glass panels.
- Phone-first redesign: status headline, tickets with inline Allow/Deny, one main action per step, sheets; IBM Plex bundled.
- Steps end when the lead reports done; autopilot runs the next step until a checkpoint; Start and run; Add and start.
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
- Backend split into `lib/` modules.

Removed
- `TaskCompleted` hook and the `CLAUDE.md` template written into projects; `MISSION.md`, `KICKOFF.md`, `run.sh`, `HANDOFF.md`.
