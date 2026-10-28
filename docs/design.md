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
| D17 | Phone-first app: a status headline at home, one ticket per cartridge, one main action per step, everything else in sheets. Cobalt for actions, signal orange when an agent needs the user | The console shell was too busy; most use is a glance and one tap from the phone |
| D18 | No dependencies; IBM Plex Sans and Mono bundled (OFL, Latin and Vietnamese subsets) | Simple install, works offline, readable agent replies in Vietnamese |
| D19 | One console for many projects (git repositories); cartridge ids carry the project id | Real work spans several repos |
| D20 | Each team may write only inside its own cartridge folder (hook) | Isolation between teams and from the main checkout |
| D21 | Nothing the tool adds is committed: `/plans/`, worktrees, tool files and local settings go into `.git/info/exclude` | Team notebooks must not leak into upstream repos |
| D22 | No `CLAUDE.local.md`; team rules travel in the phase prompts (`{{RULES}}`) and the lead passes them to teammates | `CLAUDE.local.md` makes Claude ignore `AGENTS.md`, and teammates do not see the lead's chat |
| D23 | Read-only views of Claude Code data: `claude agents --json` (status), team config (members, panes), transcripts (messages, cost), status line JSON (plan usage) | Structured data instead of guessing from the screen, without touching the sessions |
| D24 | Everything in the repo is English | The user's rule for persisted artifacts |
| D26 | Work cartridges choose a quick, standard or full flow; all three build and review logic, security, tests, docs and skills (`{{CHECKS}}`) | Most issues are small or medium; the full flow's dozen agents waste quota on them, but no flow may skip the five checks |
| D27 | Review + QA and the merge checkpoint send work back to the build, then Simplify and Review + QA run again | Fixes land on the affected tasks, not on a restart |
| D28 | A step ends when the lead's reply starts with its marker (`PLAN DONE`, `BUILD DONE`…); with autopilot on, the next agent step runs by itself and the flow stops at checkpoints. Answers to waiting agents work from the home list | The user should only act at checkpoints and permission prompts |
| D29 | The home list shows each running cartridge's newest lead line, one orb per agent (dark while its screen moves, orange while it waits), and steps done as a hairline. Plan usage is two rings | A glance at the phone should say what every team is doing without opening anything |
| D30 | Issues are listed across all projects at once, filtered to the user's own (`--assignee @me`) by default, and searched through GitHub search | With several repos, picking work should not start with picking a repo |
| D31 | Autopilot has three levels. Hands-off (the default) approves the spec and plan checkpoints, sends a NEEDS WORK review back to Build up to twice, answers the trust question for the cartridge's own worktree, and runs a waiting step once the lead is idle. Checkpoints stops at each checkpoint; Manual runs nothing. The merge always waits for the user | The user wants to act only where it matters: permissions and the merge |
| D32 | The terminal tab draws tmux's colours (`capture-pane -e`) and always opens on the newest line | It should read like the real terminal |
| D25 | A project can pin a Node version from nvm (setting, else `.nvmrc`); its bin goes first on PATH inside the session shell | Some repos' hooks need another Node than the machine default. tmux gives panes the client's PATH and ignores `-e PATH` |
| D33 | A project can set a setup command (install, build) that runs once in every new work or review worktree, in the background, with the project's Node first on PATH; the first step waits for it, and a failure shows on the cartridge with its log | A fresh worktree has no `node_modules` or build output, so the first commit failed its pre-commit hook and agents spent turns installing |
| D34 | A review after a fix round keeps the earlier report (`plans/review-<n>.md`), checks each earlier critical or major finding, and reads only the diff since the previous review (`{{SINCE}}`: the commit that review covered) | Re-reviewing the whole change each round overwrote the findings the fix was based on and cost a full read for nothing |
| D35 | In the quick flow the lead builds alone; planning and the review stay separate steps. Plan templates list risks and open questions under separate headings, and say "None" when there are no questions | For a small task a developer teammate only re-read what the lead had just read, while the review keeps fresh eyes. `openQuestions()` reads numbered items under any heading that mentions questions, so a "Risks and open questions" heading stopped hands-off at every plan |
| D36 | The assistant is a chat on `claude -p`: one Claude session per chat, resumed for every message, streamed, with read-only tools and project settings only. It answers with evidence and an English reply draft, and proposes action cards; the console runs a card only when the user taps it, through the same code as the buttons | From a phone the user needs an answer machine over the workspace and GitHub, not a terminal. Print mode gives clean text and never prompts; the cards keep D3 and D13 |
| D37 | The Chat tab is the lead's transcript (read only) turned into turns: what the user or the console sent, what the lead said, its tool calls folded into one line, teammate messages. The console remembers the first words of everything it sends (`state.sent`), so step prompts show as a collapsed chip and nudges, send-backs and hand-overs as console lines. Quick replies send fixed texts or run console actions | A terminal scraped off tmux is hard to read on a phone and mixes the prompts in; the transcript is structured and complete, and the user needs to tell their own words from the console's |
| D38 | Every step prompt carries `{{SUMMARY}}`: before its DONE line the lead appends a fixed-key section to `plans/summary.md` (verdict, counts, acceptance, tests, changed, top findings as `file:line`, questions, decided for you, next). The console shows the last finished step's section at checkpoints, on the home ticket and in pushes, and falls back to the head of the step's report | A verdict and the three findings that matter must be readable in one glance from the phone; one accumulating file is also the record of the whole cartridge |
| D39 | `GET excerpt` returns ±20 lines of a tracked file at HEAD of the cartridge, after the same inside-the-folder and no-symlink checks as the file API; nothing else of the code is readable from the console | A finding's `file:line` should be checkable without opening a laptop, without widening the file API to the whole tree |
| D40 | Away mode: in hands-off and full auto, a lead waiting on the user in the middle of a step for longer than `questionTimeoutMin` (global, per-cartridge override, default 15, 0 = off) is told once per step to decide by itself and to note it under "Decided for you". Checkpoints and the merge still wait | The user should not have to sit at the console to keep a step moving; what the lead decided alone stays visible and can be overridden in the chat |
| D41 | PR comments are read when asked (Check PR comments), never on a timer; "new" means not yet handed to the team. Full auto reads them once at the merge with an open PR and after each push, and hands new ones to the team as a build round | Polling GitHub from every open cartridge costs API calls for nothing most of the day; the moments that matter are known |
| D42 | Tidy up measures every cartridge folder, archive and leftover with `du` in the background, cached ten minutes, never inside the 4 s watcher. It lists what can go in groups and runs only what the user ticked: safe items (finished cartridges, hibernation, clean orphan worktrees, stale worktree records, `git gc --auto`) are ticked, destructive ones (branches, archives, research folders) are not. **Clean now** confirms the list; each action is logged to the project's `actions.log` | Worktrees each carry `node_modules` and build output and fill the disk; measuring large folders takes seconds; D3 holds: nothing goes without a tick |
| D43 | Deleting a branch is a separate, explicit, merged-only step, never part of eject: the local branch when its pull request is merged or `git branch --merged <base>` lists it, the remote branch only when the pull request is merged and `origin` has it. Every eject is noted in `<project>/.claude/team-ui/ejected.json` (cap 200) so later Tidy passes can offer those branches | Rule 6 keeps work safe at eject; a merged branch carries no work, and the pull request's word covers squash merges that git does not see as merged |
| D44 | Hibernate: a powered-off cartridge untouched for `hibernateDays` (7) drops what its setup can put back, through the project's `cleanCommand`, or by default the `node_modules`, `.turbo`, `dist` and `.next` folders down to depth 3 that git does not track. The state keeps the size before and after; Start runs the setup command again first | Frees most of a worktree's space while keeping the worktree, branch, notebook and conversation |
| D45 | Idle power-off: a running cartridge where no step runs (a checkpoint waits, all steps are done, or nothing was run), no pane asks anything and no pane or transcript moved for `idlePowerOffMin` (120, 0 = off) gets the soft stop (`/exit`, teammates shut down), is marked `autoOff`, and pushes once. Start on it adds `--continue` | An idle team holds hundreds of MB per agent for nothing; the conversation survives a clean exit, and a running step is never cut |
| D46 | Home shows how many Claude processes run and their memory (`ps -eo rss,args` every 30 s on macOS and Linux: `claude`, `…/claude/versions/<v>` for teammates, or a `claude` script run by node or a shell), red above `ramWarnPct` (70) of the Mac's memory. Teammates idle 15 min after a step ended show as "N idle agents"; **Dismiss** asks the lead to shut them down, the console never kills them | Memory is what runs out first with several teams; teammates belong to the lead (D1) |
| D47 | Cost guard: before autopilot runs an agent step (after a step, a waiting step, a full-auto checkpoint, a hands-off fix round), a cartridge whose cost reached its `budgetUSD` (default `defaultBudgetUSD`, 0 = none), or a 5-hour or 7-day usage at `quotaPausePct` (90), pauses with the reason, one push, and **Run anyway** (runs it, the budget becomes cost plus the same budget again) and **Raise budget**. The user's own Run always runs. The cost is Claude Code's API-equivalent figure from the transcripts | Autopilot can spend a quota unattended; the user decides whether more is worth it, and on a subscription the figure is quota, not a bill |
| D48 | Projects can set environment variables (`KEY=VALUE` per line) for the cartridge's session shell, setup and clean-up; names match `^[A-Z_][A-Z0-9_]*$` and never `ANTHROPIC_*`, `CLAUDE*` or `CTU_*`, and they are exported before the console's own variables | Some repos need a variable to build or test; D2 and the guard's cartridge id must not be overridable |
| D49 | On macOS the console can run at login as a launchd agent (`scripts/install-launchagent.sh`, `./start.sh --install`): `node server.js` from the repo with the chosen flag, `RunAtLoad`, `KeepAlive`, logs in `~/Library/Logs/claude-team-ui/`, and a `PATH` of the folders where node, tmux, gh, git and claude were found at install time | A launchd agent gets no shell profile; fixing the paths at install time is explicit and visible in the plist |
| D50 | An empty assistant chat offers prepared questions: what needs me, the weekly report (the exact `gh search` and `gh pr list` commands and the repositories spelled out in the prompt), a pull request summary, where the open cartridge stands | The common asks should be one tap on the phone, and a spelled-out command list keeps the assistant from guessing repositories or flags |
| D51 | A pasted GitHub issue or pull request link (or `owner/repo#n`) in the picker is matched to the project whose repository (`gh repo view`, cached 10 min) it names, fetched by number and ticked at the top as "from the link"; an unknown repository gets a toast. The assistant prompt carries the same rule | Someone sends a link; picking it should not start with a search |
| D52 | Posting a review to its pull request is a human tap, like Open PR: the report is previewed and editable, the console PR footer is appended, and `gh pr comment` runs only from the Post button. The guard still blocks agents from commenting | The last word on someone else's PR stays the user's |
| D53 | Two requests in a row that never reach the server show an "unreachable" bar with the last time it answered; the next answer hides it | A phone on Tailscale should say when the Mac is asleep instead of going quiet |
| D54 | Plan usage is refreshed from claude.ai's usage endpoint with the login Claude Code saved, not by a model call: the home screen asks when its figures are 3 minutes old, a tap asks now, and the cost guard asks when they are 5 minutes old. The token is read (keychain via `security`, else `.credentials.json`), never renewed or written; an expired login waits for Claude's next run. A window past its reset time is dropped instead of shown | The status line only reports while a cartridge runs, so the rings went hours stale and the guard could pause on last week's 91%; a `claude -p` ping would spend quota to read quota |

## Architecture

```
browser ──HTTP(cookie)──▶ server.js
                           ├─ lib/cartridges.js  projects, cartridges, phases, settings, start/stop, PR
                           ├─ lib/tmux.js        one session per cartridge: <prefix>-<cartridge id>
                           │     └─ sh -c "unset API keys; export CTU_CART=…; [caffeinate -i] claude --teammate-mode … --name … [--permission-mode] [--model] [--continue] [--remote-control]"
                           ├─ lib/claude.js      claude agents --json · ~/.claude/teams · ~/.claude/projects/*.jsonl · claude -p
                           ├─ lib/github.js      gh issue / pr · git push (Open PR only)
                           ├─ lib/assistant.js   claude -p --session-id | --resume … --output-format stream-json --allowedTools <read only> (the assistant chat)
                           ├─ lib/housekeeping.js  Tidy up: du sizes (cached), finished/idle/orphan checks, the tidy actions
                           └─ hooks/             guard.mjs (PreToolUse) · statusline.mjs (plan usage)
```

### Projects and cartridges
- Config `~/.config/claude-team-ui/config.json`: `projects[{id, path, testCommand, setupCommand, cleanCommand, env, node}]`, `models{strong, fast}`, `scanRoots[]`,
  `idlePowerOffMin` (120), `hibernateDays` (7), `ramWarnPct` (70), `defaultBudgetUSD` (0), `quotaPausePct` (90).
  `--project <dir>` adds a project. Removing one only unregisters it.
- Cartridge records live per project in `<project>/.claude/team-ui/slots.json`:
  `{id, kind: team|review|research, home?, title, issue, url, branch, base, target, targetCart, pr, prUrl, dir, createdAt}`.
- Folders: work and review → `<project>/.claude/worktrees/<name>`; research → `<project>/.claude/research/<name>`;
  main checkout (`home: true`) → the project folder itself.
- State per cartridge: `<dir>/.claude/team-ui/state.json` with `request`, `phases`, `mode` (planning|code), `start`
  options, `startedAt`, `history`, `setup` (`{status: running|ok|failed, cmd, line, startedAt, endedAt}`), `reviewedSha`
  (HEAD when the last review step ended), `sent` (the first words of each text the console sent, for the chat), `pr`
  (`{new, total, seen, checkedAt, decision}` from Check PR comments), `questionTimeoutMin` and `autoDecided` (away mode),
  `budgetUSD` (null = the default), `paused` (`{step, title, kind: budget|quota, reason, at}`), `pauseWaived` (Run anyway at a
  full-auto checkpoint), `autoOff` (`{at, idleMin}`), `hibernated` (`{at, before, after, removed}`),
  plus `projectDir`/`cartId` for the guard. Action log: `actions.log`. Setup
  output: `setup.log`. Exit marker: `claude-exited`. The notebook is archived to `<project>/.claude/team-ui/archive/` on eject, and
  the eject is noted in `<project>/.claude/team-ui/ejected.json` (`{id, title, kind, branch, base, pr, prUrl, ejectedAt, archive}`, newest first, 200 at most).
  Tidy actions are logged to `<project>/.claude/team-ui/actions.log` as `tidy-<action>`.

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
The same pass powers off a cartridge idle past `idlePowerOffMin` (D45). Memory is sampled by its own 30 s timer (D46);
Tidy up sizes are computed on request or when home asks and the cache is older than ten minutes (D42).

### Team, messages, usage
- Team: the team config whose lead `cwd` is the cartridge folder (or whose `leadSessionId` matches the lead session).
  Pane labels come from `members[].tmuxPaneId`.
- Messages: `<teammate-message teammate_id=… summary=…>` entries in the cartridge's transcripts; the receiver is the
  transcript's `agentName` (the lead when absent). Idle notices are dropped.
- Cost: the last `cost-state` record of each transcript, summed. Transcripts are scanned incrementally.
- Plan usage: `rate_limits` from the status line JSON and the assistant's rate limit events, saved to
  `<configDir>/usage.json`. When nothing runs, `GET https://api.anthropic.com/api/oauth/usage` (what `/usage` calls) with
  Claude Code's saved OAuth token and `anthropic-beta: oauth-2025-04-20` fills the same file (D54).

### Sending text
One line: `send-keys -l`. Several lines: `load-buffer` + `paste-buffer -p` (bracketed paste), then Enter after 400 ms.

## API

JSON, cookie `ctu`, every POST needs `X-CTU: 1`. Per-cartridge routes take `cart` in the query or the body.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/overview` | Projects, cartridge summaries, running count, models, plan usage |
| GET | `/api/suggest` | Git repositories under the scan roots that are not projects |
| POST | `/api/project-add` `{path}` · `/api/project-remove` `{project}` · `/api/project-update` `{project, testCommand, node, setupCommand}` | Projects |
| POST | `/api/settings` `{models?, scanRoots?}` | Settings |
| GET | `/api/issues?project=&assignee=&author=&label=&state=&sort=&q=` · `/api/prs?project=&mine=&author=&review=&draft=&decision=&q=` · `/api/branches?project=` | Issues and pull requests via gh (filters validated, then gh flags or search qualifiers); default base and branches |
| GET | `/api/repo-ids` · `/api/issue?project=&number=` · `/api/pr?project=&number=` | owner/name of each project's repository (cached 10 min) · one issue or pull request by number, in the list shape, for a pasted link |
| POST | `/api/cart-add` `{project, issues[] , branch?, base?, fetch?}` or `{project, title, body, createIssue, branch?, base?, fetch?}` | Work cartridges |
| POST | `/api/cart-add-home` `{project}` · `/api/cart-add-review` `{project, target or pr}` · `/api/cart-add-research` `{project, question, title?}` | Other cartridges |
| POST | `/api/draft-issue` `{text}` | `claude -p` with a JSON schema |
| POST | `/api/forward` `{cart, to}` · `/api/cart-remove` `{cart}` | Send a report · eject |
| GET | `/api/state?cart=` · `/api/pane?cart=&id=&lines=` | Cartridge state and panes · pane text and screen kind |
| POST | `/api/start` `{cart, opts, resume}` · `/api/stop` `{cart, hard}` · `/api/restart` · `/api/trust` · `/api/setup` | Session control; setup runs the project's setup command again |
| POST | `/api/send` `{cart, pane?, text}` · `/api/key` `{cart, pane?, key}` | Input |
| POST | `/api/request` · `/api/mode` `{mode}` · `/api/phase` `{phase, action: run|done|approve|reject|reopen, text?, feedback?}` · `/api/reset` | Workflow |
| GET/POST | `/api/prompt?phase=` · `/api/template?name=` · `/api/template` `{name, text or null}` | Prompts and per-project templates |
| GET | `/api/team` · `/api/plans` · `/api/file?path=` · `/api/git` | Team, messages, usage · notebook · file (`plans/`, `CLAUDE.md`, `.claude/team-ui/setup.log`) · git |
| GET/POST | `/api/pr-draft` · `/api/pr-open` `{title, body, base, draft}` | Pull request |
| GET/POST | `/api/pr-comment-draft` · `/api/pr-comment` `{body}` | The review report as a pull request comment: preview with the footer · post it (`reviewPrUrl` and `prComment` on `GET state`) |
| POST | `/api/assistant/send` `{text, conversation?, cart?}` (server-sent events `open`, `text`, `status`, `done`, `error`) · `/api/assistant/act` `{conversation, message, index}` · `/api/assistant/delete` `{id}` · `/api/assistant/clear` | Assistant: a message, a tapped card, chats removed |
| GET | `/api/assistant/list` · `/api/assistant/get?id=` | Assistant chats (`<configDir>/assistant/<id>.json`) |
| GET | `/api/chat?file=&since=` · `/api/excerpt?file=&line=` | The lead's conversation as turns from a transcript cursor (`reset` when the transcript changed) · ±20 lines of a tracked file at HEAD |
| POST | `/api/pr-check` · `/api/question-timeout` `{min or null}` | Read the PR's comments now (`new`, `total`, `decision`) · away mode for this cartridge |
| GET | `/api/tidy?fresh=` | The tidy report: `carts[]` (bytes, finished, hibernate, cleanBytes, freeBytes), `projects[]` (orphans, logs, archives, archiveBytes, prunable, branches, pnpm), `totals` (cartridges, archives, claudeProjects, freeable). Cached ten minutes; `fresh=1` waits for a new pass |
| POST | `/api/tidy` `{actions: [{type, cart?, project?, path?, branch?, remote?}]}` | Runs the ticked actions one by one (`eject`, `hibernate`, `prune`, `orphan`, `setup-log`, `archive`, `branch`, `gc`, `store-prune`); answers `results[]` and `freed` |
| POST | `/api/dismiss` · `/api/budget` `{budgetUSD or null}` · `/api/run-anyway` | Ask the lead to shut idle teammates down · the cartridge's budget (lifts a pause) · run the paused step |

`GET state` also carries `digest` (the last finished step's summary section, or the head of its report), `pr`, `questionTimeoutMin` and the global default; `GET overview` carries a small digest and `pr.new` per cartridge, and `POST settings` takes `questionTimeoutMin`.
`GET state` and each cartridge in `GET overview` carry `paused`, `autoOff`, `hibernated`, `idleAgents` and the budget (`budgetUSD`, `budgetDefault` and `costUSD` in state); `GET overview` also carries `ram` (`{count, bytes, at, totalBytes}`), `tidy` (the cached totals) and the five settings, which `POST settings` takes. `POST project-update` takes `cleanCommand` and `env` (text or object), `POST start` takes `budgetUSD`, and `POST cart-remove` answers `clean` (`{branch, merged, prMerged, why, remoteExists}`) and `freed`.

Public without login: `/style.css`, `/fonts/*.woff2`, the login page.

## Security
- Token from `TEAM_UI_TOKEN` or generated once (mode 600). HMAC cookie, HttpOnly, SameSite=Strict, 30 days.
  Constant-time comparisons, growing delay on wrong tokens.
- POST requires `X-CTU: 1` (CSRF). Listens on 127.0.0.1 unless `--lan`; use Tailscale outside the home network.
- The file API reads only `plans/` (symlinks may not lead out) and `CLAUDE.md` of a cartridge.
- The trust dialog is never answered automatically. A PR from a fork can carry `.claude/` hooks or `.mcp.json`.
