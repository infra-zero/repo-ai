import {
	claudeSkillStatus,
	pluginInstallPaths,
	pluginSkillStale,
	resolveSkillsDir,
	RETIRED_SKILLS,
	SHIPPED_SKILLS,
	skillDiffCommand,
	type SkillStatus,
} from '../cli/generators/claude-skills.js'
import { installWorkflow, SHIPPED_WORKFLOWS, workflowsDirFor } from '../cli/generators/workflows.js'
import type { CheckResult } from './types.js'

/**
 * The user-global agent skills this package ships (#404).
 *
 * The only check that reports on state *outside* the repo being audited, which
 * is why it never returns `drift` or `missing`: an out-of-date `~/.claude/skills`
 * is not a defect in this repo, and either of those statuses would fail its CI
 * over a file CI has never seen. `optional-missing` is the honest verdict — an
 * opt-in workflow tool that isn't configured — and it leaves the exit code alone.
 *
 * `skillsDir` is doctor's `--skills-dir`. Without it this reported against
 * `~/.claude/skills` whatever directory the repo actually installs into, so a
 * consumer who passes the flag to `fix` saw a permanent false `optional-missing`
 * for a skill they have (#485).
 */
export async function checkClaudeSkills(skillsDir?: string): Promise<CheckResult> {
	const check = 'Claude skills'
	const hint = `Run \`npx @rtorcato/repo-ai fix claude-skills\` to install the ${SHIPPED_SKILLS.join(', ')} skills (writes outside the repo; opt-in, so \`fix\` alone skips it)`
	const statuses: [string, SkillStatus][] = []
	for (const name of SHIPPED_SKILLS) statuses.push([name, await claudeSkillStatus(name, skillsDir)])

	if (statuses.every(([, s]) => s.file === null)) {
		return {
			check,
			status: 'optional-missing',
			detail: `no ~/.claude/skills — the ${SHIPPED_SKILLS.join(', ')} skills are not installed`,
			hint,
		}
	}
	const missing = statuses.filter(([, s]) => !s.installed).map(([name]) => name)
	const behind = statuses.filter(([, s]) => s.installed && s.needsInstall)
	if (missing.length > 0 || behind.length > 0) {
		const parts = [
			missing.length > 0 ? `not installed: ${missing.join(', ')}` : null,
			...behind.map(
				([name, s]) =>
					`${name} is at ${s.installedVersion ?? 'an unstamped version'}; this package ships ${s.shippedVersion}`
			),
		].filter((p) => p !== null)
		return { check, status: 'optional-missing', detail: parts.join('; '), hint }
	}
	// A local fork is `ok` for the same reason a modified copied asset is (#448):
	// it is somebody's deliberate work, so it is named once and never nagged as
	// fixable — pointing at a `fix` that would refuse is worse than saying nothing.
	// `realFile` is set whenever `contentState` is — both mean something is
	// installed. The extra test is TypeScript's, not a real condition.
	const forks = statuses.filter(
		([, s]) => s.realFile && s.contentState && s.contentState !== 'pristine'
	)
	if (forks.length > 0) {
		const detail = forks
			.map(([name, s]) => {
				const why =
					s.contentState === 'modified'
						? `has local changes since ${s.installedVersion}`
						: 'carries no content record, so a fork cannot be told from a stale copy'
				return `${name} skill at ${s.file} ${why}; this package ships ${s.shippedVersion} and will not overwrite it`
			})
			.join('; ')
		// Name both paths: "diff it against the shipped copy" left the reader
		// with nothing to diff, in the one case they most want to look (#484).
		const diffs = forks
			.map(([, s]) =>
				s.realFile
					? `\`${skillDiffCommand({ realFile: s.realFile, shippedFile: s.shippedFile })}\``
					: null
			)
			.filter((d) => d !== null)
			.join(', ')
		return {
			check,
			status: 'ok',
			detail,
			hint: `Diff against the shipped copy — ${diffs} — then run \`npx @rtorcato/repo-ai fix claude-skills --force-skills\` to take the shipped version`,
		}
	}
	const versions = new Set(statuses.map(([, s]) => s.installedVersion))
	return {
		check,
		status: 'ok',
		detail: `${SHIPPED_SKILLS.length} skills installed at ${[...versions].join(', ')}`,
	}
}

/**
 * The skills *this repo* declares it depends on — `requiredSkills` in
 * `.repo-ai.json` (#533, moved from `.repo-tooling.json` by #38). Where
 * `checkClaudeSkills` above reports on the
 * package's whole skill set as a machine-level nicety, this one is the repo
 * asserting a dependency, so it names the skills the repo actually runs on and
 * reports a stale installed copy against them.
 *
 * Staleness is the failure mode it exists for. Absence fails loudly the moment
 * something reaches for the skill; a copy three releases behind runs to
 * completion without complaint — observed 2026-08-26, an `ai-loop` missing
 * both its decision-comment security gate and its decay rule.
 *
 * Same severity rule as `checkClaudeSkills`, for the same reason: it probes the
 * machine, not the repo, so it never returns `drift` or `missing`. A contributor
 * with no Claude installed must not fail this repo's `doctor`.
 *
 * **Check and hint only.** The fixer writes into `~/`, and repo config that
 * triggers writes outside the repo is the shape of a supply-chain attack even
 * when the content is benign. doctor says stale; the human runs the fixer.
 */
export async function checkRequiredSkills(
	names: string[],
	skillsDir?: string
): Promise<CheckResult> {
	const check = 'Required skills'
	// ai-loop was ai-issue-loop before #56, and absorbed ai-workflow (#87) and
	// ai-tick (#89); existing configs still name them.
	names = [...new Set(names.map((name) => (RETIRED_SKILLS.includes(name) ? 'ai-loop' : name)))]
	const hint =
		'Run `npx @rtorcato/repo-ai fix claude-skills` yourself to install or refresh them — add `--force-skills` to overwrite a locally modified copy. It writes to `~/.claude`, outside this repo, so nothing runs it for you.'
	// A name outside SHIPPED_SKILLS has no shipped asset to hash against, and
	// reading one would throw rather than report. The published schema rejects it
	// in an editor; this is the runtime half of the same validation.
	const unknown = names.filter((name) => !SHIPPED_SKILLS.includes(name))
	if (unknown.length > 0) {
		return {
			check,
			status: 'optional-missing',
			detail: `requiredSkills lists ${unknown.join(', ')}, which this package does not ship`,
			hint: `requiredSkills accepts ${SHIPPED_SKILLS.join(', ')}`,
		}
	}

	const statuses: [string, SkillStatus][] = []
	for (const name of names) statuses.push([name, await claudeSkillStatus(name, skillsDir)])

	const missing = statuses.filter(([, s]) => !s.installed).map(([name]) => name)
	// `needsInstall` is `behind && pristine`, so these two partitions are disjoint:
	// a copy matching no shipped version is a fork, not something to update.
	const stale = statuses.filter(([, s]) => s.installed && s.needsInstall)
	const modified = statuses.filter(([, s]) => s.contentState && s.contentState !== 'pristine')

	const parts = [
		missing.length > 0 ? `not installed: ${missing.join(', ')}` : null,
		...stale.map(
			([name, s]) =>
				`${name} is stale — installed ${s.installedVersion ?? 'unstamped'}, this package ships ${s.shippedVersion}`
		),
		...modified.map(
			([name, s]) => `${name} at ${s.file} matches no version this package has shipped`
		),
	].filter((part) => part !== null)

	if (parts.length === 0) {
		return {
			check,
			status: 'ok',
			detail: `${names.length} required skill(s) installed and current: ${names.join(', ')}`,
		}
	}
	return { check, status: 'optional-missing', detail: parts.join('; '), hint }
}

/**
 * The Claude Code plugin copy of the shipped skills (#132), against what this
 * package ships (#154). The plugin is Claude Code's own unversioned git
 * checkout — never a fork a human hand-edited — so unlike `checkClaudeSkills`
 * a mismatch is always staleness, never something to protect. Same severity
 * rule: it probes `~/.claude/plugins`, not the repo, so it never fails doctor.
 */
export async function checkPluginSkills(home?: string): Promise<CheckResult> {
	const check = 'Plugin skills'
	const installPaths = await pluginInstallPaths(home)
	if (installPaths.length === 0) {
		return {
			check,
			status: 'optional-missing',
			detail: 'not installed via the Claude Code plugin',
			hint: 'Run `/plugin install repo-ai@repo-ai` in Claude Code, or skip it and use `fix claude-skills` instead',
		}
	}
	const stale = new Set<string>()
	for (const installPath of installPaths) {
		for (const name of SHIPPED_SKILLS) {
			if (await pluginSkillStale(name, installPath)) stale.add(name)
		}
	}
	if (stale.size > 0) {
		return {
			check,
			status: 'optional-missing',
			detail: `plugin copy behind this package: ${[...stale].join(', ')}`,
			hint: 'Run `/plugin update repo-ai@repo-ai` in Claude Code',
		}
	}
	return {
		check,
		status: 'ok',
		detail: `plugin copy at ${installPaths.length === 1 ? installPaths[0] : `${installPaths.length} install paths`} matches what this package ships`,
	}
}

/**
 * The Workflow scripts the skills run by name (#40): does the installed copy
 * match the one this package ships? Same severity rule as `checkClaudeSkills`
 * — it probes `~/.claude`, not the repo — and the same fork courtesy: a copy
 * `fix` would refuse to overwrite is named, never nagged.
 */
export async function checkWorkflows(skillsDir?: string): Promise<CheckResult> {
	const check = 'Claude workflows'
	const hint = `Run \`npx @rtorcato/repo-ai fix claude-skills\` to install the ${SHIPPED_WORKFLOWS.join(', ')} workflows`
	const { dir } = await resolveSkillsDir(skillsDir)
	if (!dir) {
		return {
			check,
			status: 'optional-missing',
			detail: 'no ~/.claude/skills to install beside',
			hint,
		}
	}
	const statuses = []
	for (const name of SHIPPED_WORKFLOWS) {
		statuses.push(await installWorkflow(workflowsDirFor(dir), name, { dryRun: true }))
	}
	const stale = statuses.filter((s) => s.status === 'installed' || s.status === 'updated')
	if (stale.length > 0) {
		const detail = stale
			.map((s) =>
				s.status === 'installed'
					? `${s.name} not installed`
					: `${s.name} differs from the ${s.shippedVersion} this package ships`
			)
			.join('; ')
		return { check, status: 'optional-missing', detail, hint }
	}
	const forks = statuses.filter((s) => s.status === 'declined-fork')
	if (forks.length > 0) {
		return {
			check,
			status: 'ok',
			detail: forks
				.map(
					(s) => `${s.name} at ${s.file} matches no version this package shipped; not overwritten`
				)
				.join('; '),
			hint: `Diff against the shipped copy — ${forks.map((s) => `\`${skillDiffCommand({ realFile: s.file, shippedFile: s.shippedFile })}\``).join(', ')} — then \`fix claude-skills --force-skills\` to take it`,
		}
	}
	return {
		check,
		status: 'ok',
		detail: `${SHIPPED_WORKFLOWS.length} workflows match what this package ships`,
	}
}
