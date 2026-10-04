---
title: Run in Docker
description: Run the loop around the clock in Docker on your Mac — a dashboard plus one container per agent, as a GitHub App, with no terminal open.
---

# Run in Docker

`docker compose up` starts the loop with no terminal and no Claude Code session to keep open. You get:

- **dashboard** at `http://localhost:8080`, a TanStack Start app. It's where you add repos, assign agents, and watch the boards.
- **api**, the only process that ticks. It reads the labels, applies `loop apply`, and queues the work. It isn't published to your Mac; the dashboard talks to it over the compose network.
- **worker-1, worker-2, …**, one container per agent. Each one takes a task from the api, runs it with a headless agent CLI (Claude Code by default, or Codex or Gemini), and reports back.

The loop works the way it does in a terminal: GitHub labels hold all the state, two agents review every PR, and you merge by hand. It authenticates as a **GitHub App**, so there's no second account and no switching gh profiles.

## 1. Create the GitHub App

On GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Webhook:** turn it off. The api polls.
- **Repository permissions:**
  - Contents: read and write
  - Issues: read and write
  - Pull requests: read and write
  - Actions: read
  - Checks: read
  - Metadata: read
- Grant nothing else. In particular, no Administration and no Secrets.
- **Where can it be installed:** only on this account.

Create it, note its **App ID**, and generate a **private key** (a `.pem` download). Then **Install App** on the repos the loop should work. Install it only on those repos.

## 2. Configure

From the repo root:

```sh
cp docker/.env.example docker/.env
cp ~/Downloads/<your-app>.*.private-key.pem docker/github-app.pem
openssl rand -hex 32   # paste as REPO_AI_WORKER_SECRET
claude setup-token     # paste as CLAUDE_CODE_OAUTH_TOKEN (or set ANTHROPIC_API_KEY)
```

Fill in `docker/.env`. Both files are gitignored. On a Linux host, make the key readable by the containers' `node` user (uid 1000), for example with `chmod 644 docker/github-app.pem`. Docker Desktop on a Mac needs nothing. Each container gets only what it uses:

- **api:** the App id and key (as a compose secret).
- **workers:** only their own runner's model credential, so a codex worker never holds the Claude token. Workers never see the App key: each task arrives with a one-hour token scoped to its repo.
- **dashboard:** neither.

All three share `REPO_AI_WORKER_SECRET`.

## 3. Start it

```sh
docker compose -f docker/compose.yml up --build -d
open http://localhost:8080
```

Under **Setup**:
- Add each repo as `owner/repo`. It's cloned into the `repos` volume on the first tick.
- Set each worker's role:
  - `any`
  - `implementer`, for `ai-ready` issues
  - `reviewer`, for code and security reviews
  - `fixer`, for review changes and conflicts
- Optionally limit a worker to some repos.
- Tick **Dependabot → review** to have new Dependabot PRs labelled `ai-review` and reviewed like any other PR.

Then label an issue `ai-ready`. The board shows it move through the stages: implemented, then reviewed by two agents, then `merge-ready` and assigned to you.

Loop limits (`maxInFlight`, `maxFixRounds`, and so on) still come from each repo's own `.repo-ai.json`.

## More agents

Copy a `worker-N` block in `docker/compose.yml`, bump the number, and run `docker compose … up -d`. The new worker shows up on the dashboard as `any`, ready to be assigned a role.

## Other agent CLIs

A worker runs Claude Code unless its block names another runner:

```yaml
  worker-3:
    <<: *worker
    hostname: worker-3
    command: ["worker", "--runner", "codex"]   # or "gemini"
    environment:
      <<: *worker-env
      CODEX_API_KEY: ${CODEX_API_KEY:?set it in docker/.env}   # or GEMINI_API_KEY
```

The `environment` block replaces the Claude credential the default worker carries, so each worker container holds only the key its runner uses. The agent process gets only that key too: the worker strips every other runner's credential before it starts the agent.

| Runner | CLI | Credential in `docker/.env` | Cost on the dashboard |
|---|---|---|---|
| `claude` | `claude -p` | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | yes |
| `codex` | `codex exec --json` | `CODEX_API_KEY` | tokens only |
| `gemini` | `gemini -p` | `GEMINI_API_KEY` | tokens only |

The image installs all three. The prompts are the same for every runner.

## What it can and cannot do

- **It never merges.** You do, as in the terminal loop.
- **Agents run with their approval prompts off (`bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`), but only inside their container.** The container has no host mounts besides its volumes, runs as a non-root user, and holds a token for one repo that expires after an hour.
  - A prompt-injected agent could push to branches and comment.
  - It cannot merge past your required checks or publish anything.
- **The dashboard listens on `127.0.0.1` only, and answers only loopback `Host` headers.**
  - It reaches the api through server functions, so the shared secret never reaches the browser.
- **Every api endpoint needs `REPO_AI_WORKER_SECRET`.**
- **Titles are shown inert; issue and PR bodies are never shown.**
- **Agents never touch the api's clones.** Each task runs in a fresh clone inside its worker, deleted when it ends.
- **Restarting is safe:** the labels are the state. A task that was running when its worker died is re-queued after 90 seconds. A claim left behind is released by stall reaping.
