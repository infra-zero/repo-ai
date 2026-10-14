/**
 * The loop's statusline segment (#11). The shipped `statusline/ai-loop.sh` is
 * copied to a stable path under `~/.claude` — the package's own path is an npx
 * cache entry that can vanish — and `statusLine` in `~/.claude/settings.json`
 * points at it only when the user has no statusline of their own.
 */
import path from 'node:path'
import chalk from 'chalk'
import fs from 'fs-extra'
import { getPackageRoot } from '../cli/utils/package-root.js'
import { FixerAbort } from './fixer-abort.js'
import type { CheckResult } from './types.js'

export const INSTALLED_NAME = 'ai-loop-statusline.sh'

export const shippedScript = (): string => path.join(getPackageRoot(), 'statusline', 'ai-loop.sh')
export const installedScript = (home: string): string => path.join(home, '.claude', INSTALLED_NAME)
const settingsFile = (home: string): string => path.join(home, '.claude', 'settings.json')

/** The line to add to an existing statusline script, which knows its own cwd. */
export const callLine = (home: string): string => `"${installedScript(home)}" "$cwd"`

async function readSettings(home: string): Promise<Record<string, unknown> | null> {
	const file = settingsFile(home)
	if (!(await fs.pathExists(file))) return {}
	try {
		return await fs.readJson(file)
	} catch {
		return null
	}
}

function statusLineCommand(settings: Record<string, unknown>): string | null {
	const sl = settings.statusLine as { command?: unknown } | undefined
	return typeof sl?.command === 'string' ? sl.command : null
}

/**
 * Whether a statusline command already shows the loop status: it runs the
 * installed script, or a script it runs reads the status file itself (a
 * hand-rolled segment). Path tokens are read with `~` and `$HOME` expanded.
 */
async function showsLoopStatus(command: string, home: string): Promise<boolean> {
	const mentions = (s: string) => s.includes(INSTALLED_NAME) || s.includes('ai-loop-status')
	if (mentions(command)) return true
	for (const token of command.split(/\s+/)) {
		const file = token
			.replace(/^["']|["']$/g, '')
			.replace(/^~(?=\/)/, home)
			.replace(/^\$HOME(?=\/)/, home)
		if (!file.includes('/')) continue
		const text = await fs.readFile(file, 'utf-8').catch(() => '')
		if (mentions(text)) return true
	}
	return false
}

/** `fix statusline`: returns the files written. */
export async function installStatusline(home: string): Promise<string[]> {
	const written: string[] = []
	const target = installedScript(home)
	const shipped = await fs.readFile(shippedScript(), 'utf-8')
	const current = await fs.readFile(target, 'utf-8').catch(() => null)
	if (current !== shipped) {
		await fs.outputFile(target, shipped, { mode: 0o755 })
		await fs.chmod(target, 0o755)
		written.push(target)
	}

	const settings = await readSettings(home)
	if (settings === null) {
		throw new FixerAbort(
			'settings-unparseable',
			`${settingsFile(home)} is not valid JSON — not overwriting it`,
			`Fix the file by hand, then re-run, or call ${target} from your statusline yourself`
		)
	}
	const command = statusLineCommand(settings)
	if (command === null) {
		// Writes through a symlinked settings.json into its target, as intended.
		await fs.outputJson(
			settingsFile(home),
			{ ...settings, statusLine: { type: 'command', command: `sh "${target}"` } },
			{ spaces: 2 }
		)
		written.push(settingsFile(home))
	} else if (!(await showsLoopStatus(command, home))) {
		console.error(chalk.yellow('   you already have a statusline — left it alone.'))
		console.error(chalk.yellow('   add this line where your script prints its segments:'))
		console.error(`   ${callLine(home)}`)
	}
	return written
}

/**
 * Like the skills check, it reports on the machine, not the repo, so it never
 * returns `drift` or `missing` — and `/ai-loop-status` already answers "what is
 * the loop doing" without a statusline.
 */
export async function checkStatusline(home: string): Promise<CheckResult> {
	const check = 'Statusline'
	const hint = 'Run `npx @rtorcato/repo-ai fix statusline` (writes to ~/.claude, outside the repo)'
	const settings = await readSettings(home)
	const command = settings ? statusLineCommand(settings) : null
	if (!command || !(await showsLoopStatus(command, home))) {
		return {
			check,
			status: 'optional-missing',
			detail: command
				? 'your statusline does not show the loop status'
				: 'no statusline configured',
			hint: command ? `${hint}, then add \`${callLine(home)}\` to your script` : hint,
		}
	}
	const installed = await fs.readFile(installedScript(home), 'utf-8').catch(() => null)
	if (installed !== null && installed !== (await fs.readFile(shippedScript(), 'utf-8'))) {
		return {
			check,
			status: 'optional-missing',
			detail: `${installedScript(home)} is out of date`,
			hint,
		}
	}
	return {
		check,
		status: 'ok',
		detail:
			installed === null
				? 'your statusline shows the loop status with its own segment'
				: 'statusline shows the loop status',
	}
}
