<!-- brand-kit:banner:start -->
<picture>
  <source media="(max-width: 640px)" srcset="./brand/banner-mobile.png">
  <img src="./brand/banner.png" alt="repo-ai banner" width="1600">
</picture>
<!-- brand-kit:banner:end -->

# @infrazero/repo-ai

The **ai-loop** pipeline: a label-driven loop that takes an `ai-ready` GitHub issue, implements it in its own git worktree, opens a PR, has two agents review it, and hands it to a human to merge.

issue → loop → PR → two reviews → you merge → [you release](https://docs.infrazero.dev/repo-ai/docs/getting-started#6-merging-and-releasing).

This package holds the moving parts: the Claude Code skills, the `loop` commands they call, and a `doctor`/`fix` pair for the loop's setup. It was split out of [`@rtorcato/repo-tooling`](https://github.com/rtorcato/repo-tooling) so the tooling can be used without the loop.

New here? [Getting started](https://docs.infrazero.dev/repo-ai/docs/getting-started) is the one-page walkthrough from zero to a first handed-over PR. See [the docs site](https://docs.infrazero.dev/repo-ai/docs/ai-loop) for how the pipeline works.

## Requirements

repo-ai targets **Claude Code** only for now; other agent harnesses aren't supported yet. What each part depends on:

| Part | Depends on |
|---|---|
| `repo-ai` CLI (`loop …`, `doctor`, `fix`, `setup`) | Node ≥ 22 and `gh`. Harness-neutral, so any agent or script can call it |
| Skills (`ai-loop`, `ai-issue`, `ai-loop-status`, `ai-loop-stop`) | The Claude Code skill format |
| Parallel implement/review (`ai-loop` Pass 3 and Pass 4, via the `ai-loop-recover` and `ai-loop-pickup` workflows) | The **Workflow** tool. Named reviewer types (`code-reviewer`, `security-expert`) need them in the Agent tool's registry; otherwise the reviewers run as `general-purpose`. Without Workflow, `ai-loop` falls back to background Agent calls |
| Self-scheduling (`/ai-loop` keeps itself going) | A session-scoped recurring **CronCreate** job |
| Wake on change (`loop watch`) | The **Monitor** tool |
| Statusline segment | Claude Code's statusline JSON |

Workflow runs show in `/workflows`. If you edit the scripts in `workflows/`, load `/workflow-authoring` first.

## Set up

```bash
npx @infrazero/repo-ai setup
```

> **⚠️ Costs and liability.** By installing or using repo-ai, you accept these risks and responsibilities. repo-ai runs AI agents unattended, and they spend your Anthropic credits or plan limits and your GitHub Actions minutes. The loop's limits are best-effort, not a spending guarantee. Set spend limits with your provider, and stop the loop when you aren't watching it. Agents can be wrong, so you review and merge every change. Provided as is under the MIT license, with no warranty; the authors aren't liable for costs, damages or changes made by agents. Not affiliated with Anthropic or GitHub. Read the full [Risks and responsibilities](https://docs.infrazero.dev/repo-ai/docs/risks).

`setup` shows this notice first and asks `Continue? (y/N)`, once per machine (recorded in `~/.config/repo-ai/acknowledged`) and again if the text changes; `--yes` or `--json` counts as acceptance.

One guided run: `.repo-ai.json`, the skills, the loop's allow rules and the statusline segment, asking before each, plus the loop labels without asking, then `doctor`. Just want to see it work? The [Minimum path](https://docs.infrazero.dev/repo-ai/docs/minimum-path) is three commands. Then `/ai-issue`, `/ai-loop`, and when a PR is `merge-ready`, you merge and [you release](https://docs.infrazero.dev/repo-ai/docs/getting-started#6-merging-and-releasing). The skill step installs `ai-loop`, `ai-issue`, `ai-loop-status` and `ai-loop-stop` into `~/.claude/skills` (or `--skills-dir <path>`).

### Installing the skills

**Use `setup`.** It runs `fix claude-skills`, which installs the four skills (`ai-loop`, `ai-issue`, `ai-loop-status`, `ai-loop-stop`) and the two Workflow scripts they run by name (`ai-loop-pickup`, `ai-loop-recover`), stamped with the npm version you ran. By default they go to `~/.claude/skills` and `~/.claude/workflows`, for every project on the machine.

**Sharing them with your team?** Install into the repo instead and commit the result:

```bash
npx @infrazero/repo-ai fix claude-skills --skills-dir .claude/skills
```

The Workflow scripts land next to them in `.claude/workflows`, so everyone who clones the repo runs the same version.

**Prefer a plugin?** In Claude Code, run `/plugin marketplace add infra-zero/repo-ai`, then `/plugin install repo-ai@repo-ai`. You get the same four skills and both Workflow scripts, registered as `repo-ai:ai-loop-pickup` and `repo-ai:ai-loop-recover`, which `ai-loop` finds on its own. The plugin is **unversioned**: it follows `main`, so it can run ahead of the npm release. Pick one way, not both.

Either way, the skills call the CLI through `npx @infrazero/repo-ai`.

**Models and reviewers.** The `ai-loop` skill pins `model: sonnet`, and its quick verification step pins `haiku`. Reviews run as `code-reviewer` and `security-expert` when you have agents with those names in `.claude/agents` or `~/.claude/agents`. Otherwise they run as `general-purpose`, with the reviewer's brief in the prompt. `doctor`'s `Reviewer agents` line tells you which you'll get.

**Moving over from repo-tooling?** Skills installed by `@rtorcato/repo-tooling` carry that package's version stamp, so this installer treats them as local edits and won't overwrite them. Run it once with `--force-skills`.

### Optional mods

Mods are Claude Code plugins built on its early-access mod API. They need **Claude Code 2.1.292** or later and may break between Claude Code releases. Neither `setup` nor `fix` installs them. Add the marketplace once with `/plugin marketplace add infra-zero/repo-ai`, then install any of these:

| Mod | Install | What it does | Needs |
|---|---|---|---|
| `release-guard` | `/plugin install release-guard@repo-ai` | Stops an agent from releasing outside CI: npm publish, version bumps, a local semantic-release run, git tags and tag pushes, force pushes, `git push --tags` or `--follow-tags`, release workflow dispatches (and any dispatch by a numeric or `$var` workflow ID), milestone closes (they fire the release workflow), GitHub releases and `package.json` `"version"` edits. It tells the agent to have you run the command yourself with `! <command>`. | Nothing else |
| `loop-watch` (experimental) | `/plugin install loop-watch@repo-ai` | A live view of the loop: a status line segment (`🤖 <summary> · next 9m · 2 agents · 1 ready to merge`), a `/loop-watch` pane of the open PRs and issues with `ai-*` labels, a toast and chime when a PR passes both reviews, and a dock with one tile per running subagent. | `gh` |
| `repo-ai-rainbow` | `/plugin install repo-ai-rainbow@repo-ai` | A colourful band above the prompt with the open `ai-*` label counts and the loop status. `/repo-ai` refreshes it. | `gh` |

`release-guard` matches command text rather than parsing the shell, so it catches an agent's slip, not an adversary. It deliberately allows `gh pr merge`. Required checks and the `release` environment remain the real gates.

`loop-watch` reads the same `.claude/ai-loop-status` as the statusline segment and polls `gh` every 2 minutes. It sees only this session's agents; agents in other sessions show up through their labels and the status file.

`release-guard` follows `main`. `loop-watch` and `repo-ai-rainbow` are pinned to a release commit, so a push to `main` never changes what you have installed.

## Commands

| Command | What it does |
|---|---|
| `setup [--yes] [--json]` | Onboard a repo: runs `fix config`, `fix claude-skills`, `fix allow-rules` and `fix statusline`, asking before each. With an agent user, it prints the `GH_TOKEN` launch line instead of running the deprecated `fix ai-loop-identity`. It also creates or repairs the loop labels without asking and reports them in one line. Then it runs `doctor`. |
| `doctor [--json]` | Audit the loop setup: the loop labels against their spec; `.repo-ai.json` present and valid against its schema; `agentUser` matches the `gh` identity; `humanUser` set on an organisation-owned repo; `autoMerge` only with a release gate; **CI runs** — default-branch push runs cancelled or pending with no jobs, or a `ciWorkflow` that does not exist; **Release approval** — a `release` run waiting on approval for over a day; **Release run** — the newest completed default-branch run whose `release` job failed. Both read `release.yml`'s runs (any event) when the repo has one, else the CI workflow's push runs; **Security alerts** — open Dependabot alerts, high/critical named and moderate/low folded into the count, silent on 403/404; installed skills, plugin skills and workflows, and whether they are current; `requiredSkills` installed; the Claude Code `permissions.allow` rules a tick needs; with Claude Code's sandbox on, `gh *` and `npx @infrazero/repo-ai *` in `sandbox.excludedCommands`; whether your statusline shows the loop status; and that agents have checks to run before pushing — a `checkCommand`, or a `CLAUDE.md` or `AGENTS.md`. `requiredSkills`, permissions and the sandbox are checked only when `agentUser` is set. All read-only. Exits 1 only on `drift` / `missing`. |
| `auth app-token --repo <owner/repo> [--json]` | Print an installation token for the loop's GitHub App, scoped to one repo, from `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` (or `GITHUB_APP_PRIVATE_KEY`). `GH_TOKEN=$(npx @infrazero/repo-ai auth app-token --repo o/r)` puts `gh` and `git` on the App's identity for an hour. An installation token cannot call `GET /user`, so set `REPO_AI_GH_LOGIN=<slug>[bot]` (the `--json` `login`) alongside it. |
| `dashboard [--port 8080] [--data /data] [--repos /repos]` | The Docker `api` service: the one scheduler (tick → apply → queue), the worker queue, and the JSON the dashboard app draws. See [Run in Docker](https://docs.infrazero.dev/repo-ai/docs/docker). |
| `worker [--url http://dashboard:8080] [--id <hostname>]` | A Docker agent worker: pulls a task from the dashboard, runs it with headless Claude Code, reports back. |
| `fix config` | Write `$schema`, and every unset key that has a default, into `.repo-ai.json`. With no file, create one, migrating any old `.repo-tooling.json` settings once. |
| `fix labels` | Repair loop label colours and descriptions with `gh label edit`. |
| `fix claude-skills` | Install or update the skills, and the Workflow scripts they run by name (`workflows/*.js` → `~/.claude/workflows`). `--force-skills` overwrites a modified or newer copy. |
| `fix ai-loop-identity` | Deprecated (#285): point this checkout's Claude sessions at a `gh` profile signed in as `agentUser`. Prefer a per-session `GH_TOKEN`. |
| `fix repo-settings` | Set the GitHub settings the loop needs, and nothing else: squash as the only merge method, auto-merge allowed, delete branch on merge, and no required pull request reviews (one identity can't approve its own PRs, so a required review deadlocks every PR). Keeps every required status check the default branch already has and never removes a rule. With none, it offers the check names from the default branch's last CI run; under `--yes` it requires none and says so. Never adds a ruleset or CodeQL. Shows the plan and asks before writing; `--yes` applies it. Needs a repo admin. |
| `fix allow-rules` | Add the loop's missing Claude Code allow rules to this checkout's gitignored `.claude/settings.local.json`: `Bash(gh:*)`, `Bash(git *)`, `Bash(npx @infrazero/repo-ai *)`, and `Bash(<pm>:*)` for the package manager its lockfile names. It also adds `permissions.deny` rules for the escapes those open: `git -c`, `git config`, `git --config-env`, `git --exec-path`, and the package manager's `dlx`/`exec`/`x`/`create`/`init`. Appends only, and refuses to write through a symlinked `.claude` or settings file. Writes nothing when another settings file already grants them, or a bare `Bash` allows everything. |
| `fix sandbox` | With Claude Code's sandbox on, add `gh *` and `npx @infrazero/repo-ai *` to `sandbox.excludedCommands` in the settings file that turns it on. An allow rule only skips the prompt; a sandboxed `gh` fails TLS on macOS (no keychain) and `npx` can't write its cache, so a tick halts or needs an unsandboxed retry the auto-mode classifier may refuse. Excluding `gh *` gives `gh` your keychain and network, which the loop needs anyway to label PRs. Never sets `enabled`, never creates a `sandbox` block, and writes nothing while the sandbox is off. Chained calls (`cd x && gh …`) still run sandboxed. |
| `fix statusline` | Install the loop's status segment (`🤖 2 agents·1 to merge · next 9m`) to `~/.claude/ai-loop-statusline.sh`, replacing that file on every run (it is ours; don't edit it). Never touches an existing statusline: sets `statusLine` in `~/.claude/settings.json` only when you have none, otherwise prints the one line to add to your own script. Never prompts. |
| `loop guard` | Repair a wrongly-bare main checkout, gate the `node_modules` rebuild, and assert the agent identity. |
| `loop env` | Print a tick's values (root, worktree root, owner/repo, agent and human users) for a human; the skill reads them from `loop tick --json`. |
| `loop worktree add <slug>` | Create an `ai-*` worktree off `origin/main` and link its dependencies. |
| `loop cleanup` | Remove `ai-*` worktrees whose PR has landed or closed. |
| `loop apply` | Apply a tick's deterministic writes: Pass 1's disarm, handoff, send-back, `merge-ready` strip and branch update; Pass 2's worktree removal (then the `node_modules` rebuild gate), `ai-wip` relabel and the label side of each stall. Its only merge is an `autoMerge` handoff. Each label edit is preceded by an upserted transition comment naming the agent (`REPO_AI_AGENT`) and the next owner (#332). Reports every edit, and in `comments` each comment the caller still owes. |
| `loop reap` | Report agents stalled past 45 minutes and what to do about each. |
| `loop comment <pr>` / `loop verdict <pr>` | Upsert the decision comment, and read a reviewer's verdict marker. |
| `loop tick` | Compute one tick's whole work list (guard, cleanup, reap, verdicts, pickups). `.skippedPickups[]` names each `ai-ready` issue it passed over and why (an untrusted author, or a file an `ai-wip` issue also names); `.dependabotRecreate` lists the red or `DIRTY` Dependabot PRs in the loop that `loop apply` asks to `@dependabot recreate`. Read-only: writes no GitHub state and removes no worktree — `loop apply` does that. |
| `loop watch` | Poll `loop tick`'s work list every `pollSeconds` and print a line only when it changes: `HH:MM  <summary>  review #78 · pickup #39 …`. An `agentUser` mismatch warns on stderr instead of halting. Runs until killed. |
| `loop tier <pr>` | Choose the review tier from the PR's changed paths: `both` (docs-only — one combined reviewer) or `split` (`code` + `sec`). Fails closed to `split`. |

Every command takes `--json`. Configuration lives in the repo's `.repo-ai.json` (`agentUser`, `requiredSkills`). `doctor` reports it missing; `fix config` creates it.

## License

MIT
