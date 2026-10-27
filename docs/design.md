# Design

How Claude Team UI works and why. Read with `docs/verify.md` (facts checked against Claude Code 2.1.311).

## Goal

A developer on a Pro/Max plan hands work to several Claude Code agent teams and supervises them, often from a phone.
Not goals: a custom orchestrator, API-key usage, merging or pushing on its own.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Use Claude Code's own agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), driven by prompts | No orchestration code of our own |
| D2 | Every session the tool starts drops `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, teammates included | Usage goes to the subscription, never to an API bill |
| D3 | Nothing runs on its own: adding creates a worktree, Start starts the team, Run sends a phase | The user decides what runs and when |
| D4 | No hard limit on running cartridges; a warning above `TEAM_UI_SOFT_LIMIT` | Quota multiplies with teams; the user chooses |
| D5 | Spec before plan, approved by the user | Planners must agree on what is asked |
| D6 | Planning is read-only and bounded: scout, two independent plans, cross-review, at most two revision loops, a final team check | Plans get reviewed without burning quota |
| D7 | No reliance on agent-team plan approval | The lead approves teammate plans by itself |
| D8 | The lock is enforced by a `PreToolUse` hook, not by words or path deny rules | Deny rules cannot express "only plans/" (`Edit(./*)` also matched `plans/`, and `Write(...)` rules never match). The hook reads the mode on every call, so switches apply at once |
| D9 | Results go to `plans/`, one writer per file; messages only point at files | Small contexts, survives compaction and restarts |
| D10 | After the plan: self-contained task files, fresh context per task, one commit per task with passing tests | Story files and fresh-context loops work |
| D11 | A simplifier on paper (planning) and in code (after build) | Cheapest when cut early |
| D12 | One git worktree + branch + tmux session per cartridge, under `<project>/.claude/worktrees/` | Teams never overwrite each other |
| D13 | Issues through `gh`; a new task can be drafted by `claude -p` and is created on GitHub only when the user ticks it | Pick an issue or describe work freely |
| D14 | Review cartridges: detached worktree at the branch or PR head (`pull/<n>/head`, so fork PRs work). Research cartridges: a plain folder with WebSearch/WebFetch allowed | Reviews never touch the working team's checkout |
| D15 | Reports move between cartridges by copying into `plans/from-<cartridge>.md` and telling the lead to propose, not act | No reads outside the cartridge; the user decides |
| D16 | Agents never push; the user's Open PR button pushes and opens the PR | The last gate stays human |
| D17 | Handheld-console shell, clean screen, phone first | Readable and easy to tap away from the desk |
| D18 | No dependencies; Press Start 2P bundled for shell labels only | Simple install, works offline |
| D19 | One console for many projects (git repositories); cartridge ids carry the project id | Real work spans several repos |
| D20 | Each team may write only inside its own cartridge folder (hook) | Isolation between teams and from the main checkout |
| D21 | Nothing the tool adds is committed: `/plans/`, worktrees, tool files and local settings go into `.git/info/exclude` | Team notebooks must not leak into upstream repos |
| D22 | No `CLAUDE.local.md`; team rules travel in the phase prompts (`{{RULES}}`) and the lead passes them to teammates | `CLAUDE.local.md` makes Claude ignore `AGENTS.md`, and teammates do not see the lead's chat |
| D23 | Read-only views of Claude Code data: `claude agents --json` (status), team config (members, panes), transcripts (messages, cost), status line JSON (plan usage) | Structured data instead of guessing from the screen, without touching the sessions |
| D24 | Everything in the repo is English | The user's rule for persisted artifacts |
| D25 | A project can pin a Node version from nvm (setting, else `.nvmrc`); its bin goes first on PATH inside the session shell | Some repos' hooks need another Node than the machine default. tmux gives panes the client's PATH and ignores `-e PATH` |

## Architecture

```
browser ──HTTP(cookie)──▶ server.js
                           ├─ lib/cartridges.js  projects, cartridges, phases, settings, start/stop, PR
                           ├─ lib/tmux.js        one session per cartridge: <prefix>-<cartridge id>
                           │     └─ sh -c "unset API keys; export CTU_CART=…; [caffeinate -i] claude --teammate-mode … --name … [--permission-mode] [--model] [--continue] [--remote-control]"
                           ├─ lib/claude.js      claude agents --json · ~/.claude/teams · ~/.claude/projects/*.jsonl · claude -p
                           ├─ lib/github.js      gh issue / pr · git push (Open PR only)
                           └─ hooks/             guard.mjs (PreToolUse) · statusline.mjs (plan usage)
```

### Projects and cartridges
- Config `~/.config/claude-team-ui/config.json`: `projects[{id, path, testCommand, node}]`, `models{strong, fast}`, `scanRoots[]`.
  `--project <dir>` adds a project. Removing one only unregisters it.
- Cartridge records live per project in `<project>/.claude/team-ui/slots.json`:
  `{id, kind: team|review|research, home?, title, issue, url, branch, base, target, targetCart, pr, prUrl, dir, createdAt}`.
- Folders: work and review → `<project>/.claude/worktrees/<name>`; research → `<project>/.claude/research/<name>`;
  main checkout (`home: true`) → the project folder itself.
- State per cartridge: `<dir>/.claude/team-ui/state.json` with `request`, `phases`, `mode` (planning|code), `start`
  options, `startedAt`, `history`, plus `projectDir`/`cartId` for the guard. Action log: `actions.log`. Exit marker:
  `claude-exited`. The notebook is archived to `<project>/.claude/team-ui/archive/` on eject.

### Settings written per cartridge (`<dir>/.claude/settings.local.json`)
Agent teams env, the `PreToolUse` guard (matcher `Edit|Write|MultiEdit|NotebookEdit|Read|Bash`), the usage status line
(unless the user set their own), and WebSearch/WebFetch for research. Entries from older versions are removed; the
user's own entries stay.

### Guard (`hooks/guard.mjs`)
Acts only when `CTU_CART` is set (the tmux session environment carries it to teammates). Blocks: writes outside the
cartridge but inside the project or another cartridge; writes outside `plans/` in planning mode; edits to the cartridge
settings and state; reading `.env*` (not `.env.example`/`sample`/`template`/`dist`) and the tool's credentials;
`git push`; `rm` with both recursive and force flags. Exit code 2 shows the reason to the agent.

### Who needs the user
Every 4 s the watcher reads the last lines of every pane (`trust`, `exit`, `permission`, `question` screens) and the
lead's `status: waiting` from `claude agents --json`. A new hit sends an ntfy message when `NTFY_URL` is set.

### Team, messages, usage
- Team: the team config whose lead `cwd` is the cartridge folder (or whose `leadSessionId` matches the lead session).
  Pane labels come from `members[].tmuxPaneId`.
- Messages: `<teammate-message teammate_id=… summary=…>` entries in the cartridge's transcripts; the receiver is the
  transcript's `agentName` (the lead when absent). Idle notices are dropped.
- Cost: the last `cost-state` record of each transcript, summed. Transcripts are scanned incrementally.
- Plan usage: `rate_limits` from the status line JSON, saved to `<configDir>/usage.json`.

### Sending text
One line: `send-keys -l`. Several lines: `load-buffer` + `paste-buffer -p` (bracketed paste), then Enter after 400 ms.

## API

JSON, cookie `ctu`, every POST needs `X-CTU: 1`. Per-cartridge routes take `cart` in the query or the body.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/overview` | Projects, cartridge summaries, running count, models, plan usage |
| GET | `/api/suggest` | Git repositories under the scan roots that are not projects |
| POST | `/api/project-add` `{path}` · `/api/project-remove` `{project}` · `/api/project-update` `{project, testCommand, node}` | Projects |
| POST | `/api/settings` `{models?, scanRoots?}` | Settings |
| GET | `/api/issues?project=` · `/api/branches?project=` | Issues via gh; default base and branches |
| POST | `/api/cart-add` `{project, issues[] , branch?, base?, fetch?}` or `{project, title, body, createIssue, branch?, base?, fetch?}` | Work cartridges |
| POST | `/api/cart-add-home` `{project}` · `/api/cart-add-review` `{project, target or pr}` · `/api/cart-add-research` `{project, question, title?}` | Other cartridges |
| POST | `/api/draft-issue` `{text}` | `claude -p` with a JSON schema |
| POST | `/api/forward` `{cart, to}` · `/api/cart-remove` `{cart}` | Send a report · eject |
| GET | `/api/state?cart=` · `/api/pane?cart=&id=&lines=` | Cartridge state and panes · pane text and screen kind |
| POST | `/api/start` `{cart, opts, resume}` · `/api/stop` `{cart, hard}` · `/api/restart` · `/api/trust` | Session control |
| POST | `/api/send` `{cart, pane?, text}` · `/api/key` `{cart, pane?, key}` | Input |
| POST | `/api/request` · `/api/mode` `{mode}` · `/api/phase` `{phase, action: run|done|approve|reject|reopen, text?, feedback?}` · `/api/reset` | Workflow |
| GET/POST | `/api/prompt?phase=` · `/api/template?name=` · `/api/template` `{name, text or null}` | Prompts and per-project templates |
| GET | `/api/team` · `/api/plans` · `/api/file?path=` · `/api/git` | Team, messages, usage · notebook · git |
| GET/POST | `/api/pr-draft` · `/api/pr-open` `{title, body, base, draft}` | Pull request |

Public without login: `/style.css`, `/fonts/*.woff2`, the login page.

## Security
- Token from `TEAM_UI_TOKEN` or generated once (mode 600). HMAC cookie, HttpOnly, SameSite=Strict, 30 days.
  Constant-time comparisons, growing delay on wrong tokens.
- POST requires `X-CTU: 1` (CSRF). Listens on 127.0.0.1 unless `--lan`; use Tailscale outside the home network.
- The file API reads only `plans/` (symlinks may not lead out) and `CLAUDE.md` of a cartridge.
- The trust dialog is never answered automatically. A PR from a fork can carry `.claude/` hooks or `.mcp.json`.
