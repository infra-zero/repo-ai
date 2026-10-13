import os from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import fs from 'fs-extra'
import inquirer from 'inquirer'
import { SETTINGS_LOCAL } from '../../base/ai-loop-identity.js'
import { loopAllowRules } from '../../base/allow-rules.js'
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
import { claudeOnPath } from '../generators/claude-skills.js'
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

/**
 * `setup` is the explicit opt-in, so unlike `fix claude-skills` it creates
 * `~/.claude/skills` itself. Otherwise a machine without Claude Code fails the
 * first run and passes the second, once `statusline` has made `~/.claude` (#358).
 */
export async function setupSkills(
	dir: string,
	o: FixOptions,
	deps: { home?: string; hasClaude?: () => Promise<boolean>; run?: StepRun } = {}
): Promise<string[]> {
	if (!o.skillsDir) {
		await fs.ensureDir(path.join(deps.home ?? os.homedir(), '.claude', 'skills'))
		if (!(await (deps.hasClaude ?? claudeOnPath)())) {
			console.error(
				chalk.dim(
					'   Claude Code not found; skills installed to ~/.claude/skills for when you install it'
				)
			)
		}
	}
	return (deps.run ?? FIXERS['claude-skills'].run)(dir, o)
}

const STEPS: Record<string, StepRun> = {
	config: FIXERS.config.run,
	'claude-skills': (dir, o) => setupSkills(dir, o),
	'allow-rules': FIXERS['allow-rules'].run,
	labels: (dir) => applyLoopLabels(dir, undefined, { bootstrap: true }),
	statusline: FIXERS.statusline.run,
}

/**
 * Steps that run without a prompt and report in one line (#365): `setup` is the
 * opt-in to the loop, so its labels come with it rather than as fifteen names
 * to learn up front.
 */
const QUIET_STEPS = new Set(['labels'])

/** `created label "a"`, `repaired label "b"`, … → `created 14, repaired 1 ai-loop labels`. */
export function quietSummary(applied: string[]): string {
	const counts = ['created', 'repaired']
		.map((verb) => [verb, applied.filter((a) => a.startsWith(`${verb} `)).length] as const)
		.filter(([, n]) => n > 0)
	return `${counts.map(([verb, n]) => `${verb} ${n}`).join(', ')} ai-loop labels`
}

/** The steps, in order. */
export const SETUP_STEPS = ['config', 'claude-skills', 'allow-rules', 'labels', 'statusline']

/**
 * With an agent user, how to run the loop as it (#365). `GH_TOKEN` is the one
 * documented path; setup no longer runs the deprecated `fix ai-loop-identity`.
 */
export function identityHint(agentUser: string | null | undefined): string | undefined {
	if (!agentUser) return undefined
	return `agentUser is ${agentUser}: launch the loop's Claude session as it with \`GH_TOKEN=$(gh auth token --user ${agentUser}) claude\``
}

export async function runSetup(
	dir: string,
	options: FixOptions,
	deps: {
		confirm?: (target: string, dir: string) => Promise<boolean>
		steps?: Record<string, StepRun>
	} = {}
): Promise<StepResult[]> {
	const steps = deps.steps ?? STEPS
	const assumeYes = Boolean(options.yes || options.json)
	const confirm = deps.confirm ?? askToRun
	const results: StepResult[] = []
	for (const target of SETUP_STEPS) {
		if (!assumeYes && !QUIET_STEPS.has(target) && !(await confirm(target, dir))) {
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

async function askToRun(target: string, dir: string): Promise<boolean> {
	const prompt =
		target === 'allow-rules'
			? `Allow the loop's own shell calls in this checkout's ${SETTINGS_LOCAL} (gitignored, this repo only), so an unattended tick doesn't stall on permission prompts:\n  ${(await loopAllowRules(dir)).join('\n  ')}\n Add them`
			: undefined
	const { run } = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'run',
			message: `${prompt ?? (FIXERS as Record<string, { description: string }>)[target]?.description ?? target}?`,
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

/**
 * `setup` fails only on what it is responsible for fixing (#369). It can't install
 * Claude Code (#368) or write allow rules (#371) or sandbox excludes, so those are
 * notes here, each naming its fix; `doctor` alone still fails on them (#359).
 */
const NOT_SETUPS_JOB = new Set(['Claude Code', 'Claude Code permissions', 'Claude Code sandbox'])

export function asSetupNotes(results: CheckResult[]): CheckResult[] {
	return results.map((r) =>
		NOT_SETUPS_JOB.has(r.check) && (r.status === 'missing' || r.status === 'drift')
			? { ...r, status: 'optional-missing' }
			: r
	)
}

/** `setup --gh-config-dir` is accepted so old invocations don't break, and does nothing (#365). */
export function warnDeprecatedOptions(options: FixOptions): void {
	if (options.ghConfigDir === undefined) return
	console.error(
		chalk.yellow(
			'⚠ setup --gh-config-dir is deprecated and ignored: setup no longer runs fix ai-loop-identity. Run the loop as the agent with `GH_TOKEN=$(gh auth token --user <agentUser>) claude`.'
		)
	)
}

export async function setupCommand(options: FixOptions): Promise<void> {
	warnDeprecatedOptions(options)
	const directory = path.resolve(options.dir)
	// No terminal — e.g. Claude Code's Bash tool — means no prompt; inquirer would die with a stack trace (#358).
	if (!options.yes && !options.json && !process.stdin.isTTY) {
		console.error(chalk.yellow.bold('Costs and liability.'), NOTICE)
		console.error(`Full text: ${RISKS_URL}`)
		console.error(
			chalk.red(
				'No terminal to prompt in: re-run with --yes to accept the notice and run every step.'
			)
		)
		process.exitCode = 1
		return
	}
	if (!(await acknowledgeNotice(options))) {
		console.error('Setup cancelled: the notice was not accepted.')
		process.exitCode = 1
		return
	}
	const steps = await runSetup(directory, options)
	const hint = identityHint(await configuredAgentUser(directory))
	const doctor = asSetupNotes(await runDoctor(directory, options.skillsDir))
	const failed =
		steps.some((s) => s.status === 'failed') ||
		doctor.some((r) => r.status === 'drift' || r.status === 'missing')
	if (options.json) {
		console.log(
			JSON.stringify(
				{ directory, acknowledged: true, steps, ...(hint && { identityHint: hint }), doctor },
				null,
				2
			)
		)
	} else {
		for (const s of steps) {
			if (s.status === 'applied' && QUIET_STEPS.has(s.target) && s.filesWritten?.length)
				console.log(chalk.green(`✓ ${s.target}: ${quietSummary(s.filesWritten)}`))
			else if (s.status === 'applied')
				for (const f of s.filesWritten ?? []) console.log(chalk.green(`✓ ${s.target}: ${f}`))
			if (s.status === 'skipped') console.log(chalk.gray(`○ ${s.target}: skipped`))
			if (s.status === 'failed') {
				console.log(chalk.red(`✗ ${s.target}: ${s.message}`))
				if (s.hint) console.log(chalk.dim(`   ${s.hint}`))
			}
		}
		if (hint) console.log(chalk.cyan(`→ ${hint}`))
		console.log(chalk.bold('\ndoctor'))
		printResults(doctor)
	}
	process.exitCode = failed ? 1 : 0
}
