/**
 * The Claude Code allow rules the loop's shell-outs need (#152). Without them
 * every `gh`/`git`/`pnpm`/`npx` call on a tick prompts or goes to the auto-mode
 * classifier, which can block the tick.
 */
import path from 'node:path'
import fs from 'fs-extra'
import type { CheckResult } from './types.js'

export const LOOP_ALLOW_RULES = [
	'Bash(gh:*)',
	'Bash(git *)',
	'Bash(pnpm:*)',
	'Bash(npx @rtorcato/repo-ai *)',
]

/** `Bash(gh:*)` and `Bash(gh *)` are the same prefix rule. */
const normalise = (rule: string): string => rule.trim().replace(/:\*\)$/, ' *)')

async function allowRules(file: string): Promise<string[]> {
	const settings = await fs.readJson(file).catch(() => null)
	const allow = settings?.permissions?.allow
	return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : []
}

/** One result per missing rule, or a single `ok` when all are present. */
export async function checkAllowRules(dir: string, home: string): Promise<CheckResult[]> {
	const check = 'Claude Code permissions'
	const files = [
		path.join(home, '.claude', 'settings.json'),
		path.join(dir, '.claude', 'settings.json'),
		path.join(dir, '.claude', 'settings.local.json'),
	]
	const have = new Set((await Promise.all(files.map(allowRules))).flat().map(normalise))
	// A bare `Bash` (or `Bash(*)`) allows every command.
	if (have.has('Bash') || have.has('Bash(*)')) {
		return [{ check, status: 'ok', detail: 'all Bash commands are allowed' }]
	}
	const missing = LOOP_ALLOW_RULES.filter((r) => !have.has(normalise(r)))
	if (missing.length === 0) {
		return [{ check, status: 'ok', detail: "all of the loop's allow rules are present" }]
	}
	return missing.map((rule) => ({
		check,
		status: 'drift',
		detail: `no "${rule}" allow rule — the loop's calls will prompt or hit the auto-mode classifier`,
		hint: `Add "${rule}" to permissions.allow in .claude/settings.json or ~/.claude/settings.json`,
	}))
}
