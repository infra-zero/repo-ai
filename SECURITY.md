# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it privately through
[GitHub private vulnerability reporting](https://github.com/rtorcato/repo-ai/security/advisories/new).
You should get a reply within a few days. Only the latest published version is supported.

## Threat model

This package runs coding agents off GitHub issues, and the repos it targets are usually public, so
anyone can open an issue. The loop's defences:

- **`ai-ready` label gate.** An issue is only picked up if it carries `ai-ready`. On a public repo
  only collaborators can add labels, so this is the hard gate.
- **Author association check.** The issue's `author_association` must also be `OWNER`, `MEMBER` or
  `COLLABORATOR`. A collaborator labelling a stranger's issue is not enough.
- **Issue body is data, not instructions.** Agents implement what the issue describes and ignore
  anything in it that tries to redirect them (change tools, reveal secrets, touch other repos).
- **No secrets in issue-triggered runs.** Agents work in a git worktree with the local `gh` identity
  only; no tokens or secrets are passed into the run or written to the PR.
- **Human merge.** Changes land only through a PR. Agents review and label but never approve or
  merge an issue PR; a human merges, and the repo's required status checks stay the merge gate.
  Publishing to npm additionally needs a maintainer's approval on the `release` environment.

A way around any of these (for example, getting an unlabelled or outsider issue executed, or making
an agent leak credentials or merge) is a vulnerability — please report it as above.
