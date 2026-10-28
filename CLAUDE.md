# Claude Team UI: notes for Claude Code working in this repo

Read `docs/design.md` first: decisions, architecture, API, security. `docs/verify.md` holds what was verified against
real Claude Code. Do not change a decision there without the user's agreement; propose it with reasons.

## Commands
- Run: `./start.sh [project dir...] [--lan]` or `node server.js --project <dir> --port 7700`
- Test: `npm test` (end-to-end with fake `claude`/`gh` in `test/fakes`; needs tmux and git). It must pass before you report done.
- Syntax: `npm run check`

## Layout
- `server.js`: HTTP routes, the watcher (attention, ntfy, usage), startup.
- `lib/`: `config.js` (argv/env, config file, token), `cartridges.js` (Project, Cartridge, Registry, phases),
  `claude.js` (sessions, team config, transcripts, screen detection, issue drafting), `tmux.js`, `github.js`, `util.js`.
- `lib/housekeeping.js`: Tidy up (sizes, finished/idle/orphan checks, the tidy actions).
- `scripts/install-launchagent.sh`: run the console at login on macOS through launchd (`./start.sh --install`; `--print` for tests).
- `hooks/guard.mjs` (PreToolUse lock and isolation), `hooks/statusline.mjs` (records plan usage).
- `public/`: `index.html`, `app.js` (plain JS), `style.css`, `login.html`, `fonts/` (Press Start 2P, OFL).
- `prompts/`: one file per phase plus `_rules.md` (team rules), `_checks.md` (the five quality checks) and `_summary.md` (the digest every step appends to `plans/summary.md`). Variables: `{{REQUEST}} {{RULES}} {{CHECKS}} {{SUMMARY}} {{STRONG}} {{FAST}} {{TEST}} {{BRANCH}} {{BASE}} {{TARGET}} {{SCOPE}} {{PROJECT}} {{SINCE}} {{STEP}}`
  (`SINCE`: the commit the previous review of the cartridge covered, or "the previous review" before any review).
- `test/smoke.mjs`, `test/fakes/{claude,gh}`.

## Rules
1. No dependencies (npm or CDN). Node built-ins and plain JS/CSS only.
2. Nothing runs unless the user clicked for it: no auto-start, no auto-run of phases, no issue/PR/push on its own.
3. Every tmux call goes through `lib/tmux.js` (API-key-free env). Input to a pane goes through `Cartridge.paneFor()`,
   so it never reaches another cartridge. State, settings, notebook and git are per `cartridge.dir`.
4. Never write to `~/.claude/teams`, `~/.claude/tasks`, `~/.claude/projects`. Read them tolerantly; the formats are not public.
5. Web security: everything inserted into HTML goes through `esc()`; every POST needs the `X-CTU` header; the file API
   reads only `plans/` and `CLAUDE.md` of a cartridge; ids and pane ids are validated.
6. Destructive actions (eject, power off, restart the flow) always confirm in the UI; eject refuses uncommitted changes
   and never deletes a branch or a research folder.
7. Nothing the tool writes inside a project may end up in a commit: keep new paths in `EXCLUDES` (`lib/cartridges.js`).
8. When Claude Code's real behaviour differs from what the code assumes, fix the code, update `test/fakes` to match
   the real format, add a check to `test/smoke.mjs`, and note it in `docs/verify.md`.
9. UI: phone first (390 px wide). One loud element per screen, one main action per step, secondary actions in sheets.
   Tap targets at least 44 px, inputs at least 16 px text. No all-caps labels. Motion only for the running step.
10. Everything in the repo is in English: code, comments, UI text, prompts, docs, commit messages.
