# Contributing

`main` is protected: every change lands through a squash-merged PR, and the `verify` CI job is the
required check.

1. **Open or pick an issue**, then branch per issue from `main`:
   `<type>/<issue-N>-<short-name>`, e.g. `fix/12-reap-timeout`. One issue per branch and PR.
2. **Commit with [Conventional Commits](https://www.conventionalcommits.org/)** (enforced by commitlint).
3. **Run `pnpm verify` before pushing** — Biome check, typecheck, tests and build.
4. **Give the PR a Conventional Commit title.** It becomes the squash commit on `main`, and
   semantic-release reads it to decide what the next release contains. Merging does not release:
   a release is a manual `release.yml` dispatch or a closed milestone, approved on the `release` environment. Put `Closes #N` in the body.

Every command supports `--json`; in JSON mode diagnostics go to stderr, never stdout.

Security issues: see [SECURITY.md](SECURITY.md), not the public tracker.
