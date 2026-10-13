/**
 * The Claude Code allow rules the loop's shell-outs need (#152). Without them
 * every `gh`/`git`/package-manager/`npx` call on a tick prompts or goes to the auto-mode
 * classifier, which can block the tick.
 */
import path from 'node:path'
import fs from 'fs-extra'
import { ensureIgnored, SETTINGS_LOCAL } from './ai-loop-identity.js'
import { FixerAbort } from './fixer-abort.js'
import { detectPackageManager } from './package-manager.js'
import type { CheckResult } from './types.js'

/** The rules every checkout needs; {@link loopAllowRules} adds the package manager's. */
export const LOOP_ALLOW_RULES = ['Bash(gh:*)', 'Bash(git *)', 'Bash(npx @infrazero/repo-ai *)']

/** {@link LOOP_ALLOW_RULES} plus `Bash(<pm>:*)` for the lockfile's package manager (#360), if any. */
export async function loopAllowRules(dir: string): Promise<string[]> {
	const pm = await detectPackageManager(dir)
	return pm
		? [...LOOP_ALLOW_RULES.slice(0, 2), `Bash(${pm}:*)`, ...LOOP_ALLOW_RULES.slice(2)]
		: LOOP_ALLOW_RULES
}

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

/** The loop's rules no settings file grants yet; null when a bare `Bash` allows everything. */
async function missingAllowRules(dir: string, home: string): Promise<string[] | null> {
	const have = new Set(
		(await Promise.all(settingsFiles(dir, home).map(allowRules))).flat().map(normalise)
	)
	// A bare `Bash` (or `Bash(*)`) allows every command.
	if (have.has('Bash') || have.has('Bash(*)')) return null
	return (await loopAllowRules(dir)).filter((r) => !have.has(normalise(r)))
}

/**
 * `setup`'s allow-rules step (#371): merge the missing rules into this checkout's
 * gitignored `.claude/settings.local.json`, so the grant covers only this repo and
 * is never committed. Appends only — existing rules and every other key stay put.
 * Logs each rule it adds; returns the files written.
 */
export async function fixAllowRules(dir: string, home: string): Promise<string[]> {
	const missing = await missingAllowRules(dir, home)
	if (!missing?.length) {
		console.error("   the loop's allow rules are already present")
		return []
	}
	const file = path.join(dir, SETTINGS_LOCAL)
	let settings: Record<string, unknown> = {}
	if (await fs.pathExists(file)) {
		try {
			settings = await fs.readJson(file)
		} catch {
			throw new FixerAbort(
				'settings-local-unparseable',
				`${SETTINGS_LOCAL} is not valid JSON — not overwriting it`,
				`Fix the file by hand, or add ${missing.map((r) => `"${r}"`).join(', ')} to permissions.allow yourself`
			)
		}
	}
	const permissions = (settings.permissions ?? {}) as Record<string, unknown>
	await fs.outputJson(
		file,
		{
			...settings,
			permissions: { ...permissions, allow: [...strings(permissions.allow), ...missing] },
		},
		{ spaces: 2 }
	)
	for (const rule of missing) console.error(`   allowed ${rule}`)
	const written = [SETTINGS_LOCAL]
	if (await ensureIgnored(dir)) written.push('.gitignore')
	return written
}

/** One result per missing rule, or a single `ok` when all are present. */
export async function checkAllowRules(dir: string, home: string): Promise<CheckResult[]> {
	const check = 'Claude Code permissions'
	const missing = await missingAllowRules(dir, home)
	if (missing === null) {
		return [{ check, status: 'ok', detail: 'all Bash commands are allowed' }]
	}
	if (missing.length === 0) {
		return [{ check, status: 'ok', detail: "all of the loop's allow rules are present" }]
	}
	return missing.map((rule) => ({
		check,
		status: 'drift',
		detail: `no "${rule}" allow rule — the loop's calls will prompt or hit the auto-mode classifier`,
		hint: `Run \`npx @infrazero/repo-ai setup\` to add it to ${SETTINGS_LOCAL}, or add "${rule}" to permissions.allow yourself`,
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
