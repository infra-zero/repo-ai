import os from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import fs from 'fs-extra'
import { checkAgentUser } from '../../base/agent-user.js'
import { checkClaudeSkills, checkRequiredSkills, checkWorkflows } from '../../base/checks.js'
import { ciRunWarning } from '../../base/ci-runs.js'
import { CONFIG_FILE, readConfig } from '../../base/config.js'
import { checkConfigSchema } from '../../base/config-schema.js'
import { type GhExec, realGhExec } from '../../base/gh.js'
import { checkLoopLabels } from '../../base/labels.js'
import { releaseGated } from '../../base/release-gate.js'
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
		await checkAutoMerge(dir, config.autoMerge === true),
		await checkCiRuns(dir),
		await checkClaudeSkills(skillsDir),
		await checkWorkflows(skillsDir),
		await checkStatusline(os.homedir()),
	]
	const schemaCheck = await checkConfigSchema(dir)
	if (schemaCheck) results.push(schemaCheck)
	if (config.source === 'repo-tooling.json') {
		results.push({
			check: 'Loop config',
			status: 'drift',
			detail: `agentUser/requiredSkills still read from legacy .repo-tooling.json rules.aiLoop`,
			hint: `Move them to ${CONFIG_FILE} — repo-ai's own config, not repo-tooling's`,
		})
	}
	// Gated on agentUser: that key is the "this repo runs the pipeline" signal.
	const required = config.requiredSkills ?? []
	if (config.agentUser && required.length > 0) {
		results.push(await checkRequiredSkills(required, skillsDir))
	}
	return results
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
	const nwo = await ghOut(gh, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
	if (!nwo) return { check, status: 'ok', detail: 'skipped — could not resolve the GitHub repo' }
	const warning = await ciRunWarning(gh, nwo, now)
	return warning
		? { check, status: 'drift', detail: warning }
		: { check, status: 'ok', detail: 'main push runs look healthy' }
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
