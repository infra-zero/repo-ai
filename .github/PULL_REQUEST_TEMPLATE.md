## Summary

<!-- 1-3 bullet points describing what changed and why -->
-

<!--
The PR title becomes the squash commit subject on `main`, and semantic-release
reads it to decide what the next release contains: feat, fix, perf, refactor,
revert and update release; docs, ci, chore, test and build do not. Pick the
type deliberately. Merging does not release: a release is a manual
`release.yml` dispatch or a closed milestone.
-->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] CI / tooling

## Test plan

- [ ] `pnpm verify` passes (check, typecheck, tests, build)
- [ ] New tests added for new behaviour
- [ ] Changed `loop` commands run locally, with and without `--json`

## Skills and the loop

- [ ] Skill change: `skills/*/SKILL.md` edited, and the matching page in `apps/docs/docs/` updated
- [ ] Loop behaviour change: tested with a manual `/ai-loop` tick
- [ ] Neither applies

## Checklist

- [ ] PR title is a Conventional Commit whose type matches the release you intend (see the note above)
- [ ] No breaking changes (or BREAKING CHANGE footer added to commit)
- [ ] In `--json` mode, only JSON goes to stdout; diagnostics go to stderr
