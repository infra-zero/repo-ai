import os from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import fs from 'fs-extra'
import { checkAgentUser } from '../../base/agent-user.js'
import { checkAllowRules } from '../../base/allow-rules.js'
import {
	checkClaudeSkills,
	checkPluginSkills,
	checkRequiredSkills,
	checkWorkflows,
} from '../../base/checks.js'
import { ciRunWarning, releaseFailedWarning, releaseStuckWarning } from '../../base/ci-runs.js'
import { CONFIG_FILE, readConfig } from '../../base/config.js'
import { checkConfigSchema } from '../../base/config-schema.js'
import { type GhExec, realGhExec } from '../../base/gh.js'
import { checkLoopLabels } from '../../base/labels.js'
import { releaseGated } from '../../base/release-gate.js'
import { securityAlertWarning } from '../../base/security-alerts.js'
import { checkStatusline } from '../../base/statusline.js'
import type { CheckResult } from '../../base/types.js'
import { ghOut } from './loop-env.js'

/**
 * The loop's own audit — the four checks that used to ride along in
 * `repo-tooling doctor`, plus the statusline (#11). Same config file, same verdicts, same exit rule:
 * `drift` / `missing` fail, everything else is informational.
 */
export async function runDoctor(dir: string, skillsDir?: string): Promise<CheckResult[]> {
	const config = await readConfig(dir)
	const results = [
		await checkLoopLabels(dir),
		await checkAgentUser(dir, config.agentUser),
		await checkHumanUser(dir, config.humanUser),
		await checkAutoMerge(dir, config.autoMerge === true),
		await checkCiRuns(dir),
		await checkReleaseStuck(dir),
		await checkReleaseFailed(dir),
		await checkSecurityAlerts(dir),
		await checkClaudeSkills(skillsDir),
		await checkPluginSkills(),
		await checkWorkflows(skillsDir),
		await checkStatusline(os.homedir()),
	]
	const schemaCheck = await checkConfigSchema(dir)
	if (schemaCheck) results.push(schemaCheck)
	if (config.source === 'none') {
		results.push({
			check: 'Loop config',
			status: 'missing',
			detail: `no ${CONFIG_FILE}`,
			hint: 'Run `npx @rtorcato/repo-ai fix config` to create it',
		})
	}
	// Gated on agentUser: that key is the "this repo runs the pipeline" signal.
	const required = config.requiredSkills ?? []
	if (config.agentUser && required.length > 0) {
		results.push(await checkRequiredSkills(required, skillsDir))
	}
	if (config.agentUser) results.push(...(await checkAllowRules(dir, os.homedir())))
	return results
}

/**
 * `humanUser` defaults to the repo owner (`loop env`'s `humanUser`), which is
 * empty for an organisation — so an org repo with no override leaves
 * merge-ready PRs, `ai-blocked` and declined issues with no assignee (#162).
 */
export async function checkHumanUser(
	dir: string,
	humanUser: string | undefined,
	exec?: GhExec
): Promise<CheckResult> {
	const check = 'Human user'
	if (humanUser) {
		return { check, status: 'ok', detail: `humanUser set to "${humanUser}"` }
	}
	if (!(await fs.pathExists(path.join(dir, '.git')))) {
		return { check, status: 'ok', detail: 'skipped — not a git repository' }
	}
	const gh: GhExec = exec ?? ((args, stdin) => realGhExec(args, stdin, dir))
	const r = await gh(['api', 'repos/{owner}/{repo}', '--jq', '.owner.type'])
	if (!r.ok) {
		return { check, status: 'ok', detail: 'skipped — could not verify the repo owner' }
	}
	if (r.stdout.trim() !== 'Organization') {
		return { check, status: 'ok', detail: 'not applicable — repo owner is a user' }
	}
	return {
		check,
		status: 'drift',
		detail:
			'organisation-owned repo with no humanUser — merge-ready PRs and ai-blocked/declined issues get no assignee',
		hint: 'Add "humanUser": "<your-login>" to .repo-ai.json',
	}
}

/** `loop tick` merges unattended only with the opt-in *and* a release gate (#142). */
export async function checkAutoMerge(
	dir: string,
	autoMerge: boolean,
	exec?: GhExec
): Promise<CheckResult> {
	const check = 'Unattended merge'
	if (!autoMerge) {
		return { check, status: 'ok', detail: `off — no "autoMerge": true in ${CONFIG_FILE}` }
	}
	// No .git → never spawn gh (keeps tmp-dir doctor runs offline).
	const gh: GhExec = exec ?? ((args, stdin) => realGhExec(args, stdin, dir))
	let gated = false
	if (await fs.pathExists(path.join(dir, '.git'))) {
		const nwo = await ghOut(gh, [
			'repo',
			'view',
			'--json',
			'nameWithOwner',
			'--jq',
			'.nameWithOwner',
		])
		gated = nwo !== '' && (await releaseGated(gh, nwo, dir))
	}
	return gated
		? { check, status: 'ok', detail: 'on — release-gated, so loop tick may merge passed PRs' }
		: {
				check,
				status: 'drift',
				detail: 'autoMerge is on but the repo is not release-gated — loop tick will never merge',
				hint: 'Put the publishing job behind an environment with required_reviewers, or drop autoMerge',
			}
}

/** `[nameWithOwner, defaultBranch]` in one `gh repo view` (#179); empty strings on failure. */
async function repoAndDefaultBranch(gh: GhExec): Promise<[string, string]> {
	const out = await ghOut(gh, [
		'repo',
		'view',
		'--json',
		'nameWithOwner,defaultBranchRef',
		'--jq',
		'.nameWithOwner + " " + .defaultBranchRef.name',
	])
	const [nwo = '', branch = ''] = out.split(/\s+/)
	return [nwo, branch]
}

/** Surfaces #153's symptom: `main` push runs stuck pending or cancelled with no jobs. */
export async function checkCiRuns(
	dir: string,
	exec?: GhExec,
	now = Date.now()
): Promise<CheckResult> {
	const check = 'CI runs'
	// No .git → never spawn gh (keeps tmp-dir doctor runs offline).
	if (!(await fs.pathExists(path.join(dir, '.git')))) {
		return { check, status: 'ok', detail: 'skipped — not a git repository' }
	}
	const gh: GhExec = exec ?? ((args, stdin) => realGhExec(args, stdin, dir))
	const [nwo, branch] = await repoAndDefaultBranch(gh)
	if (!nwo || !branch) {
		return { check, status: 'ok', detail: 'skipped — could not resolve the GitHub repo' }
	}
	const warning = await ciRunWarning(gh, nwo, branch, now)
	return warning
		? { check, status: 'drift', detail: warning }
		: { check, status: 'ok', detail: `${branch} push runs look healthy` }
}

/** Surfaces #146's symptom: a `release` run left waiting on approval, pinning main's push concurrency group. */
export async function checkReleaseStuck(
	dir: string,
	exec?: GhExec,
	now = Date.now()
): Promise<CheckResult> {
	const check = 'Release approval'
	// No .git → never spawn gh (keeps tmp-dir doctor runs offline).
	if (!(await fs.pathExists(path.join(dir, '.git')))) {
		return { check, status: 'ok', detail: 'skipped — not a git repository' }
	}
	const gh: GhExec = exec ?? ((args, stdin) => realGhExec(args, stdin, dir))
	const [nwo, branch] = await repoAndDefaultBranch(gh)
	if (!nwo || !branch) {
		return { check, status: 'ok', detail: 'skipped — could not resolve the GitHub repo' }
	}
	const warning = await releaseStuckWarning(gh, nwo, branch, now)
	return warning
		? { check, status: 'drift', detail: warning }
		: { check, status: 'ok', detail: 'no release run stuck waiting on approval' }
}

/** Surfaces #204's symptom: the last `release` job failed and nothing published. */
export async function checkReleaseFailed(dir: string, exec?: GhExec): Promise<CheckResult> {
	const check = 'Release run'
	// No .git → never spawn gh (keeps tmp-dir doctor runs offline).
	if (!(await fs.pathExists(path.join(dir, '.git')))) {
		return { check, status: 'ok', detail: 'skipped — not a git repository' }
	}
	const gh: GhExec = exec ?? ((args, stdin) => realGhExec(args, stdin, dir))
	const [nwo, branch] = await repoAndDefaultBranch(gh)
	if (!nwo || !branch) {
		return { check, status: 'ok', detail: 'skipped — could not resolve the GitHub repo' }
	}
	const warning = await releaseFailedWarning(gh, nwo, branch)
	return warning
		? { check, status: 'drift', detail: warning }
		: { check, status: 'ok', detail: 'no failed release run' }
}

/** #203: open high/critical Dependabot alerts, invisible otherwise. Moderate/low fold into the count here, not in the tick warning. */
export async function checkSecurityAlerts(dir: string, exec?: GhExec): Promise<CheckResult> {
	const check = 'Security alerts'
	// No .git → never spawn gh (keeps tmp-dir doctor runs offline).
	if (!(await fs.pathExists(path.join(dir, '.git')))) {
		return { check, status: 'ok', detail: 'skipped — not a git repository' }
	}
	const gh: GhExec = exec ?? ((args, stdin) => realGhExec(args, stdin, dir))
	const nwo = await ghOut(gh, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
	if (!nwo) {
		return { check, status: 'ok', detail: 'skipped — could not resolve the GitHub repo' }
	}
	const warning = await securityAlertWarning(gh, nwo, true)
	return warning
		? { check, status: 'drift', detail: warning }
		: { check, status: 'ok', detail: 'no open high/critical security alerts' }
}

const ICON: Record<CheckResult['status'], string> = {
	ok: chalk.green('✓'),
	drift: chalk.yellow('⚠'),
	missing: chalk.red('✗'),
	'optional-missing': chalk.gray('○'),
	declared: chalk.blue('◇'),
}

export function printResults(results: CheckResult[]): void {
	for (const r of results) {
		console.log(`${ICON[r.status]} ${r.check}: ${r.detail}`)
		if (r.hint && r.status !== 'ok') console.log(chalk.dim(`   ${r.hint}`))
	}
}

export async function doctorCommand(options: {
	dir: string
	json?: boolean
	skillsDir?: string
}): Promise<void> {
	const directory = path.resolve(options.dir)
	const results = await runDoctor(directory, options.skillsDir)
	if (options.json) {
		console.log(JSON.stringify({ directory, results }, null, 2))
	} else {
		printResults(results)
	}
	process.exitCode = results.some((r) => r.status === 'drift' || r.status === 'missing') ? 1 : 0
}
