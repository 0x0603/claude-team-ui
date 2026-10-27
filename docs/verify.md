# Verification against real Claude Code

Run on 2026-10-27 with Claude Code 2.1.311 (Max subscription, no API key), tmux 3.8, macOS.
Sandbox: a throwaway git repo in a temp directory; one cartridge started with `--teammate-mode tmux --model sonnet`.

| # | Check | Result | Evidence | Fix |
|---|---|---|---|---|
| V1 | Team file formats | Partly as assumed | `~/.claude/teams/session-<8 chars of lead session id>/config.json` has `leadSessionId`, `members[]` with `name`, `agentType`, `model`, `tmuxPaneId`, `cwd`, `backendType`, `isActive`, `prompt`. `inboxes/*.json` are arrays that are emptied once delivered. `~/.claude/tasks/<team>/` stays empty: the session has no shared task-list tools. | Read members from config. Read agent messages from session transcripts instead of inboxes. Drop the task board. |
| V2 | Multi-line prompt via bracketed paste | Pass | A 3-line message arrived as one prompt; the lead answered `MULTI OK 3`. | none |
| V3 | Planning lock via deny rules | **Fail** | With `Edit(./*)` denied, writing `plans/t.md` was denied too: `/*` matches the `plans` directory itself, gitignore-style. Claude also warned `Deny rule Write(./*) never matches · use Edit(./*)`. | Replace path deny rules with a `PreToolUse` hook that allows writes only under `plans/` in planning mode. |
| V4 | Editing `settings.local.json` while running | Pass | After switching to code mode, the running lead wrote `src/t.js` without a restart. | Reset is no longer required. The hook reads the mode on every call anyway. |
| V5 | tmux teammate panes | Partly | Teammates split into panes of the cartridge's own session and window. Pane titles are the agent type (`✳ general-purpose`), not the teammate name. | Label panes from `members[].tmuxPaneId`. |
| V6 | "Needs you" detection | Pass | The permission screen matched the regex (`Do you want to proceed?`, `1. Yes`). `claude agents --json` reported `"status": "waiting"` for the lead at the same time. | Use both signals. |
| V7 | `claude -p` for drafting an issue | Pass | Valid JSON after 27 s. Output followed the prompt language (Vietnamese). | English prompt, `--output-format json` with `--json-schema`. |
| V8 | `~/.claude/projects/<encoded cwd>` | Pass for real paths | `/.claude/worktrees/x` encodes to `--claude-worktrees-x`. A non-realpath project path (`/tmp/...` on macOS) would not match. | Resolve project paths with `realpath`, and map teams by `cwd` in the team config instead of path encoding. |
| V9 | Soft stop with `/exit` | **Fail** | With teammates alive, `/exit` opens a menu (`1. Exit and stop tasks / 2. Move to background and exit / 3. Stay`). The tool killed the session 1.5 s later. Confirming option 1 closed all teammate panes and deleted the team config. | Confirm the menu, wait for the exit marker, then kill the session. |
| V10 | Review a PR | **Fail for fork PRs** | `git fetch origin feature-update` → `couldn't find remote ref` (branch lives in the fork). `git fetch origin pull/11624/head` works. | Fetch `pull/<n>/head`. |

## Other findings

- New folders show a trust dialog whose default choice is **"No, exit"**. The A button (Enter) would quit Claude. The UI now recognises this screen and offers a "Trust folder" action.
- Auto mode is now Claude Code's default permission mode. Permission prompts are rare unless the cartridge starts in `manual`. The mode is now a Start option.
- `claude agents --json` lists interactive sessions with `cwd`, `sessionId` and `status` (`busy`, `idle`, `waiting`) in about 70 ms. Teammates in tmux panes are not listed.
- Each session transcript holds `cost-state` records (`totalCostUSD`, per-model token counts). Tmux-mode teammates have their own transcripts in the same project folder. This is enough for a read-only usage estimate per cartridge.
- On exit Claude prints `claude --resume <id>`. Starting a cartridge with `--continue` picks up the lead's last conversation in that folder.
- tmux gives a new pane the PATH of the client and ignores `new-session -e PATH=…` (other `-e` variables work). Putting the project's Node first inside the session shell works, and Claude's Bash tool kept it: `node -v` and `pnpm exec node -v` both reported v24.22.1 from nvm.
- Agents reply in the language set by the user's global `~/.claude/CLAUDE.md`, so team prompts must state the language for files, commits and PR text.
