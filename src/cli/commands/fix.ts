import os from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { fixSandboxExcludes } from '../../base/allow-rules.js'
import { setupAgentIdentity } from '../../base/ai-loop-identity.js'
import { installClaudePlugin } from '../../base/claude-plugin.js'
import { writeConfigSchema } from '../../base/config-schema.js'
import { FixerAbort } from '../../base/fixer-abort.js'
import { applyLoopLabels } from '../../base/labels.js'
import { installStatusline } from '../../base/statusline.js'
import {
	installClaudeSkill,
	RETIRED_SKILLS,
	removeRetiredSkill,
	resolveSkillsDir,
	SHIPPED_SKILLS,
	type SkillInstallResult,
	skillDiffCommand,
} from '../generators/claude-skills.js'
import {
	installWorkflow,
	RETIRED_WORKFLOWS,
	removeRetiredWorkflow,
	SHIPPED_WORKFLOWS,
	workflowsDirFor,
} from '../generators/workflows.js'

export interface FixOptions {
	dir: string
	json?: boolean
	yes?: boolean
	skillsDir?: string
	forceSkills?: boolean
	ghConfigDir?: string
}

/**
 * Each writes somewhere a repo audit should never touch on its own — the remote
 * repo's labels, `~/.claude/skills`, the checkout's gh identity — so every one
 * runs only when named. There is no bare `fix`.
 */
export interface Fixer {
	description: string
	run(dir: string, o: FixOptions): Promise<string[]>
}

export const FIXERS = {
	config: {
		description:
			'Write $schema into .repo-ai.json, creating it when missing (migrating any old repo-tooling settings once)',
		run: (dir) => writeConfigSchema(dir),
	},
	labels: {
		description: 'Repair ai-loop label colours and descriptions on GitHub via `gh label edit`',
		run: (dir) => applyLoopLabels(dir),
	},
	'claude-skills': {
		description: `Install the ${SHIPPED_SKILLS.join(', ')} skills into ~/.claude/skills (or --skills-dir), and the ${SHIPPED_WORKFLOWS.join(', ')} workflows beside them`,
		run: (_dir, o) => installSkills(o),
	},
	'ai-loop-identity': {
		description: "Point this checkout's Claude sessions at a gh profile signed in as agentUser",
		run: (dir, o) => setupAgentIdentity(dir, { ghConfigDir: o.ghConfigDir, home: os.homedir() }),
	},
	statusline: {
		description:
			'Install the loop status segment to ~/.claude/ai-loop-statusline.sh; set it as the statusline only when none is configured',
		run: () => installStatusline(os.homedir()),
	},
	'claude-plugin': {
		description:
			'Install the /ai-loop-dash pane plugin to ~/.claude/repo-ai-plugin and add it to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json',
		run: () => installClaudePlugin(os.homedir()),
	},
	sandbox: {
		description:
			"With Claude Code's sandbox on, add the loop's gh and repo-ai calls to sandbox.excludedCommands in the file that enables it",
		run: (dir) => fixSandboxExcludes(dir, os.homedir()),
	},
} satisfies Record<string, Fixer>

async function installSkills({ skillsDir, forceSkills, yes, json }: FixOptions) {
	const dir = await resolveInstallDir(skillsDir, Boolean(yes || json))
	if (!dir) return []
	const filesWritten: string[] = []
	for (const name of SHIPPED_SKILLS) {
		const result = await installClaudeSkill(dir, name, { force: forceSkills })
		if (result.status === 'declined-downgrade') {
			console.error(
				chalk.yellow(
					`   skipped — ${result.file} is stamped ${result.installedVersion}, above the ${result.shippedVersion} this package reports; not overwritten`
				)
			)
			console.error(chalk.yellow('   overwrite anyway:  fix claude-skills --force-skills'))
			continue
		}
		if (result.status === 'declined-fork') {
			for (const line of describeSkillFork(result)) console.error(chalk.yellow(`   ${line}`))
			continue
		}
		if (result.status === 'up-to-date') continue
		if (result.viaSymlink) {
			console.error(chalk.dim(`   wrote through a symlink — commit ${result.realFile}`))
		}
		filesWritten.push(result.realFile)
	}
	// The scripts the skills run by name (#40) — versioned with them, so installed with them.
	for (const name of SHIPPED_WORKFLOWS) {
		const result = await installWorkflow(workflowsDirFor(dir), name, { force: forceSkills })
		if (result.status === 'declined-downgrade' || result.status === 'declined-fork') {
			const why =
				result.status === 'declined-fork'
					? 'its content matches no version this package shipped'
					: `it is stamped ${result.installedVersion}, above the ${result.shippedVersion} this package reports`
			console.error(chalk.yellow(`   skipped — ${result.file}: ${why}; not overwritten`))
			console.error(
				chalk.yellow(
					`   compare:  ${skillDiffCommand({ realFile: result.file, shippedFile: result.shippedFile })}`
				)
			)
			console.error(chalk.yellow('   overwrite anyway:  fix claude-skills --force-skills'))
			continue
		}
		if (result.status !== 'up-to-date') filesWritten.push(result.file)
	}
	// Renamed or folded-in names (#56, #87) — a stale copy still answers its old command.
	const retired = [
		...(await Promise.all(RETIRED_SKILLS.map((name) => removeRetiredSkill(dir, name)))),
		...(await Promise.all(
			RETIRED_WORKFLOWS.map((name) => removeRetiredWorkflow(workflowsDirFor(dir), name))
		)),
	]
	for (const { file, status } of retired) {
		if (status === 'removed') console.error(chalk.dim(`   removed retired ${file}`))
		if (status === 'kept') {
			console.error(
				chalk.yellow(`   retired, but modified or symlinked — delete it yourself: ${file}`)
			)
		}
	}
	return filesWritten
}

/**
 * Where to install, asking only when nothing resolves. Under `--yes` / `--json`
 * a prompt is not available and guessing a directory is not an option, so the
 * run fails and names `--skills-dir`.
 */
async function resolveInstallDir(explicit: string | undefined, assumeYes: boolean) {
	const { dir } = await resolveSkillsDir(explicit)
	if (dir) return dir
	if (assumeYes) {
		throw new FixerAbort(
			'no-skills-dir',
			'no ~/.claude/skills found, and --yes/--json cannot prompt for one',
			'pass --skills-dir <path>'
		)
	}
	const { answer } = await inquirer.prompt([
		{
			type: 'input',
			name: 'answer',
			message: 'Install agent skills where?',
			default: path.join(os.homedir(), '.claude', 'skills'),
		},
	])
	const trimmed = typeof answer === 'string' ? answer.trim() : ''
	return trimmed ? path.resolve(trimmed) : null
}

/** Why the install refused, and what to do about it. */
function describeSkillFork(result: SkillInstallResult): string[] {
	const target = result.viaSymlink ? `${result.file} → ${result.realFile}` : result.realFile
	const why =
		result.contentState === 'modified'
			? `its content has diverged from the ${result.installedVersion} release it was installed from`
			: 'it carries no content record, so a local fork and a stale copy are indistinguishable'
	return [
		`skipped — ${result.name} was not overwritten with ${result.shippedVersion}: ${why}`,
		`  ${target}`,
		`  compare:  ${skillDiffCommand(result)}`,
		'  overwrite anyway:  fix claude-skills --force-skills',
	]
}

export async function fixCommand(target: string, options: FixOptions): Promise<void> {
	const fixer = (FIXERS as Record<string, Fixer>)[target]
	const dir = path.resolve(options.dir)
	const fail = (error: string, message: string, hint?: string) => {
		if (options.json) console.log(JSON.stringify({ target, error, message, hint }, null, 2))
		else console.error(chalk.red(`error: ${message}`) + (hint ? chalk.dim(` — ${hint}`) : ''))
		process.exitCode = 1
	}
	if (!fixer) {
		return fail('unknown-target', `unknown fix target "${target}"`, Object.keys(FIXERS).join(', '))
	}
	try {
		const filesWritten = await fixer.run(dir, options)
		if (options.json)
			console.log(JSON.stringify({ target, status: 'applied', filesWritten }, null, 2))
		else for (const f of filesWritten) console.log(chalk.green(`✓ ${f}`))
	} catch (err) {
		if (err instanceof FixerAbort) return fail(err.code, err.message, err.hint)
		throw err
	}
}
