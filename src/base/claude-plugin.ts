/**
 * The `/ai-loop-dash` pane plugin. Like the statusline, the shipped
 * `claude-plugin/` is copied to a stable path under `~/.claude`, since the
 * package's own path can be an npx cache entry that vanishes. That path then
 * joins `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, the only
 * settings file Claude Code reads it from, so every session loads the plugin.
 */
import path from 'node:path'
import fs from 'fs-extra'
import { getPackageRoot } from '../cli/utils/package-root.js'
import { FixerAbort } from './fixer-abort.js'

// ponytail: mirrors the claude-plugin entries of package.json `files`
const PLUGIN_FILES = [
	'.claude-plugin/plugin.json',
	'hooks/hooks.json',
	'hooks/register.tsx',
	'types/index.d.ts',
]

export const installedPlugin = (home: string): string =>
	path.join(home, '.claude', 'repo-ai-plugin')
const settingsFile = (home: string): string => path.join(home, '.claude', 'settings.json')

/** `fix claude-plugin`: returns the files written. */
export async function installClaudePlugin(home: string): Promise<string[]> {
	const file = settingsFile(home)
	let settings: Record<string, unknown> = {}
	if (await fs.pathExists(file)) {
		try {
			settings = await fs.readJson(file)
		} catch {
			throw new FixerAbort(
				'settings-unparseable',
				`${file} is not valid JSON — not overwriting it`,
				`Fix the file by hand, then re-run, or start Claude Code with --plugin-dir ${installedPlugin(home)}`
			)
		}
	}

	const written: string[] = []
	const target = installedPlugin(home)
	for (const rel of PLUGIN_FILES) {
		const shipped = await fs.readFile(path.join(getPackageRoot(), 'claude-plugin', rel), 'utf-8')
		const dest = path.join(target, rel)
		if ((await fs.readFile(dest, 'utf-8').catch(() => null)) === shipped) continue
		await fs.outputFile(dest, shipped)
		written.push(dest)
	}

	const env = (settings.env ?? {}) as Record<string, string>
	const dirs = (env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter).filter(Boolean)
	if (!dirs.includes(target)) {
		const CLAUDE_CODE_PLUGIN_DIRS = [...dirs, target].join(path.delimiter)
		// Writes through a symlinked settings.json into its target, as intended.
		await fs.outputJson(
			file,
			{ ...settings, env: { ...env, CLAUDE_CODE_PLUGIN_DIRS } },
			{ spaces: 2 }
		)
		written.push(file)
	}
	return written
}
