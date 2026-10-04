import path from 'node:path'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { FixerAbort } from '../../base/fixer-abort.js'
import { applyLoopLabels } from '../../base/labels.js'
import {
	acknowledgementPath,
	isAcknowledged,
	NOTICE,
	RISKS_URL,
	recordAcknowledgement,
} from '../../base/notice.js'
import type { CheckResult } from '../../base/types.js'
import { printResults, runDoctor } from './doctor.js'
import { FIXERS, type FixOptions } from './fix.js'
import { configuredAgentUser } from './loop-guard.js'
import { getToolVersion } from '../utils/version.js'

/**
 * `repo-ai setup` (#12): the loop's fixers in onboarding order, asking before
 * each, then `doctor`. A guided run of `fix` — no logic of its own beyond the
 * order, and creating the labels on a repo that has none (`setup` is the
 * explicit opt-in that `fix labels` alone deliberately does not assume).
 */

export type StepRun = (dir: string, o: FixOptions) => Promise<string[]>

export interface StepResult {
	target: string
	status: 'applied' | 'skipped' | 'failed'
	filesWritten?: string[]
	error?: string
	message?: string
	hint?: string
}

const STEPS: Record<string, StepRun> = {
	config: FIXERS.config.run,
	'claude-skills': FIXERS['claude-skills'].run,
	labels: (dir) => applyLoopLabels(dir, undefined, { bootstrap: true }),
	'ai-loop-identity': FIXERS['ai-loop-identity'].run,
	statusline: FIXERS.statusline.run,
}

/** The steps, in order. The identity step only means something with an agent user. */
export function setupSteps(agentUser: string | null | undefined): string[] {
	return [
		'config',
		'claude-skills',
		'labels',
		...(agentUser ? ['ai-loop-identity'] : []),
		'statusline',
	]
}

export async function runSetup(
	dir: string,
	options: FixOptions,
	deps: {
		confirm?: (target: string) => Promise<boolean>
		steps?: Record<string, StepRun>
	} = {}
): Promise<StepResult[]> {
	const steps = deps.steps ?? STEPS
	const assumeYes = Boolean(options.yes || options.json)
	const confirm = deps.confirm ?? askToRun
	const results: StepResult[] = []
	for (const target of setupSteps(await configuredAgentUser(dir))) {
		if (!assumeYes && !(await confirm(target))) {
			results.push({ target, status: 'skipped' })
			continue
		}
		if (!options.json) console.error(chalk.bold(`→ ${target}`))
		const run = steps[target]
		if (!run) continue
		try {
			// One fixer failing — say, no agent gh profile yet — must not stop the rest.
			const filesWritten = await run(dir, { ...options, yes: assumeYes })
			results.push({ target, status: 'applied', filesWritten })
		} catch (err) {
			if (!(err instanceof FixerAbort)) throw err
			results.push({
				target,
				status: 'failed',
				error: err.code,
				message: err.message,
				hint: err.hint,
			})
		}
	}
	return results
}

// `fix labels` only repairs; here the step also creates the set.
const PROMPTS: Record<string, string> = {
	labels: 'Create or repair the ai-loop labels on GitHub via `gh label`',
}

async function askToRun(target: string): Promise<boolean> {
	const { run } = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'run',
			message: `${PROMPTS[target] ?? (FIXERS as Record<string, { description: string }>)[target]?.description ?? target}?`,
			default: true,
		},
	])
	return Boolean(run)
}

/**
 * Show the cost and liability notice and ask `Continue? (y/N)` (#45), once per
 * machine and again whenever the notice text changes. `--yes` / `--json`
 * count as acceptance, and the notice says so.
 */
export async function acknowledgeNotice(
	options: FixOptions,
	deps: { file?: string; ask?: () => Promise<boolean> } = {}
): Promise<boolean> {
	const file = deps.file ?? acknowledgementPath()
	if (await isAcknowledged(file)) return true
	const assumeYes = Boolean(options.yes || options.json)
	console.error(chalk.yellow.bold('Costs and liability.'), NOTICE)
	console.error(`Full text: ${RISKS_URL}`)
	console.error(chalk.dim('Running with --yes or --json counts as accepting this notice.\n'))
	if (!assumeYes && !(await (deps.ask ?? askToContinue)())) return false
	await recordAcknowledgement(file, await getToolVersion())
	return true
}

async function askToContinue(): Promise<boolean> {
	const { ok } = await inquirer.prompt([
		{ type: 'confirm', name: 'ok', message: 'Continue?', default: false },
	])
	return Boolean(ok)
}

export async function setupCommand(options: FixOptions): Promise<void> {
	const directory = path.resolve(options.dir)
	if (!(await acknowledgeNotice(options))) {
		console.error('Setup cancelled: the notice was not accepted.')
		process.exitCode = 1
		return
	}
	const steps = await runSetup(directory, options)
	const doctor: CheckResult[] = await runDoctor(directory, options.skillsDir)
	const failed =
		steps.some((s) => s.status === 'failed') ||
		doctor.some((r) => r.status === 'drift' || r.status === 'missing')
	if (options.json) {
		console.log(JSON.stringify({ directory, acknowledged: true, steps, doctor }, null, 2))
	} else {
		for (const s of steps) {
			if (s.status === 'applied')
				for (const f of s.filesWritten ?? []) console.log(chalk.green(`✓ ${s.target}: ${f}`))
			if (s.status === 'skipped') console.log(chalk.gray(`○ ${s.target}: skipped`))
			if (s.status === 'failed') {
				console.log(chalk.red(`✗ ${s.target}: ${s.message}`))
				if (s.hint) console.log(chalk.dim(`   ${s.hint}`))
			}
		}
		console.log(chalk.bold('\ndoctor'))
		printResults(doctor)
	}
	process.exitCode = failed ? 1 : 0
}
