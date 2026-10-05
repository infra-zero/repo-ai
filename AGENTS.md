# AGENTS.md

Orientation for coding agents working on `@infrazero/repo-ai`.

## What this is

The ai-loop pipeline, split out of `@rtorcato/repo-tooling`:

- `skills/*/SKILL.md` — the Claude Code skills (the loop, the issue on-ramp, and the status view).
- `src/cli/commands/loop-*.ts` — the `loop` commands the skills call, with the mechanics turned into testable code.
- `src/cli/commands/{doctor,fix}.ts` — the loop's own audit and fixers.
- `src/base/{gh,git}.ts` — `gh`/`git` runners, copied from repo-tooling (not shared).

Config is read from the consuming repo's `.repo-ai.json`: `agentUser` and `requiredSkills` (`src/base/config.ts`).

## Conventions

- Conventional commits, enforced by commitlint.
- Biome for lint and format (`pnpm run check`).
- Tests in `tests/`, run with vitest.
- `pnpm verify` runs check, typecheck, tests and build, and is the pre-push gate.
- Every command supports `--json`. In JSON mode, diagnostics go to stderr, never stdout.

## Working on this repo

`main` is protected: every change lands through a PR, and the `verify` CI job is the required check.

- Branch per issue: `<type>/<issue-N>-<short-name>`, e.g. `fix/12-reap-timeout`.
- The PR title is a Conventional Commit, because it becomes the squash commit subject on `main`.
- Merges are squash-only. Branches are deleted on merge.
- Queue the merge with `gh pr merge --auto --squash --delete-branch`.
- `.husky/post-merge` runs `pnpm build` after a pull that changes `src/`, so the repo's own `dist/` stays current.
- Merging to `main` does not release. A release is a manual dispatch of `.github/workflows/release.yml` or a closed milestone, and it runs behind the `release` environment, which needs a maintainer's approval before anything is published to npm.
