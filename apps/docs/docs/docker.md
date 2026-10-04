---
title: Run in Docker
description: Run the loop around the clock in Docker on your Mac — a dashboard plus one container per agent, as a GitHub App, with no terminal open.
---

# Run in Docker

`docker compose up` starts the loop with no terminal and no Claude Code session to keep open. You get:

- **dashboard** at `http://localhost:8080`. It's where you add repos and assign agents. It's also the only process that ticks: it reads the labels, applies `loop apply`, and queues the work.
- **worker-1, worker-2, …**, one container per agent. Each one takes a task from the dashboard, runs it with headless Claude Code, and reports back.

The loop works the way it does in a terminal: GitHub labels hold all the state, two agents review every PR, and you merge by hand. It authenticates as a **GitHub App**, so there's no second account and no switching gh profiles.

## 1. Create the GitHub App

On GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Webhook:** turn it off. The dashboard polls.
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

Fill in `docker/.env`. Both files are gitignored. The App key goes only to the dashboard, as a compose secret. Workers never see it: each task arrives with a one-hour token scoped to its repo.

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

## What it can and cannot do

- **It never merges.** You do, as in the terminal loop.
- **Agents run with `bypassPermissions`, but only inside their container.** The container has no host mounts besides its volumes, runs as a non-root user, and holds a token for one repo that expires after an hour.
  - A prompt-injected agent could push to branches and comment.
  - It cannot merge past your required checks or publish anything.
- **The dashboard listens on `127.0.0.1` only.**
  - Its config endpoint takes JSON only and answers only loopback hosts.
  - Its worker endpoints need `REPO_AI_WORKER_SECRET`.
- **Titles are shown inert; issue and PR bodies are never shown.**
- **Restarting is safe:** the labels are the state. A task that was running when its worker died is re-queued after 90 seconds. A claim left behind is released by stall reaping.
