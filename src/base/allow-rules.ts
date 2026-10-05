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
	'Bash(npx @infrazero/repo-ai *)',
]

/** `Bash(gh:*)` and `Bash(gh *)` are the same prefix rule. */
const normalise = (rule: string): string => rule.trim().replace(/:\*\)$/, ' *)')

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : []

/** User, project, local — lowest precedence first. */
const settingsFiles = (dir: string, home: string) => [
	path.join(home, '.claude', 'settings.json'),
	path.join(dir, '.claude', 'settings.json'),
	path.join(dir, '.claude', 'settings.local.json'),
]

async function allowRules(file: string): Promise<string[]> {
	const settings = await fs.readJson(file).catch(() => null)
	return strings(settings?.permissions?.allow)
}

/** One result per missing rule, or a single `ok` when all are present. */
export async function checkAllowRules(dir: string, home: string): Promise<CheckResult[]> {
	const check = 'Claude Code permissions'
	const have = new Set(
		(await Promise.all(settingsFiles(dir, home).map(allowRules))).flat().map(normalise)
	)
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

/**
 * With Claude Code's sandbox on, an allow rule only skips the prompt: the call
 * still runs sandboxed, where `gh` fails TLS (no keychain on macOS) and `npx`
 * can't write its cache (#257). These run the loop's own calls outside it.
 */
export const LOOP_SANDBOX_EXCLUDES = ['gh *', 'npx @infrazero/repo-ai *']

/** `excludedCommands` takes `Bash(...)` rule syntax, so `gh:*` is `gh *`. */
const normaliseExclude = (cmd: string): string => cmd.trim().replace(/:\*$/, ' *')

async function readSandbox(dir: string, home: string) {
	const files = settingsFiles(dir, home)
	const all = await Promise.all(files.map((f) => fs.readJson(f).catch(() => null)))
	// The highest-precedence file that says anything about `enabled` decides it.
	let enabledIn: string | undefined
	for (const [i, s] of all.entries()) {
		if (typeof s?.sandbox?.enabled === 'boolean')
			enabledIn = s.sandbox.enabled ? files[i] : undefined
	}
	const have = new Set(
		all.flatMap((s) => strings(s?.sandbox?.excludedCommands)).map(normaliseExclude)
	)
	return { enabledIn, missing: LOOP_SANDBOX_EXCLUDES.filter((c) => !have.has(c)) }
}

/** One `drift` per missing exclude while the sandbox is on; `ok` otherwise. */
export async function checkSandboxExcludes(dir: string, home: string): Promise<CheckResult[]> {
	const check = 'Claude Code sandbox'
	const { enabledIn, missing } = await readSandbox(dir, home)
	if (!enabledIn) return [{ check, status: 'ok', detail: 'sandbox is off' }]
	if (missing.length === 0) {
		return [{ check, status: 'ok', detail: "the loop's calls are excluded from the sandbox" }]
	}
	return missing.map((cmd) => ({
		check,
		status: 'drift',
		detail: `sandbox is on and "${cmd}" is not in sandbox.excludedCommands — the loop's calls run sandboxed and fail`,
		hint: 'Run `npx @infrazero/repo-ai fix sandbox`',
	}))
}

/**
 * Add the missing excludes to the file that turns the sandbox on. Never touches
 * `enabled` or any other key, and writes nothing while the sandbox is off.
 */
export async function fixSandboxExcludes(dir: string, home: string): Promise<string[]> {
	const { enabledIn, missing } = await readSandbox(dir, home)
	if (!enabledIn || missing.length === 0) return []
	const settings = await fs.readJson(enabledIn)
	settings.sandbox.excludedCommands = [...strings(settings.sandbox.excludedCommands), ...missing]
	await fs.writeJson(enabledIn, settings, { spaces: 2 })
	return [enabledIn]
}
