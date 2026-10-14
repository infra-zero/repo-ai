/**
 * The Claude Code allow rules the loop's shell-outs need (#152). Without them
 * every `gh`/`git`/package-manager/`npx` call on a tick prompts or goes to the auto-mode
 * classifier, which can block the tick.
 */
import path from 'node:path'
import fs from 'fs-extra'
import { assertNotSymlinked, ensureIgnored, SETTINGS_LOCAL } from './ai-loop-identity.js'
import { FixerAbort } from './fixer-abort.js'
import { detectPackageManager, type PackageManager } from './package-manager.js'
import type { CheckResult } from './types.js'

/** The rules every checkout needs; {@link loopAllowRules} adds the package manager's. */
export const LOOP_ALLOW_RULES = ['Bash(gh:*)', 'Bash(git *)', 'Bash(npx @rtorcato/repo-ai *)']

/**
 * The package was `@infrazero/repo-ai` until #412. An allow rule or sandbox exclude
 * for the old name still passes doctor, so nobody goes red the day the rename ships,
 * but `fix` adds the new one: the shipped skills call `npx @rtorcato/repo-ai`.
 */
const legacy = (rule: string): string => rule.replace('@rtorcato/repo-ai', '@infrazero/repo-ai')

/** {@link LOOP_ALLOW_RULES} plus `Bash(<pm>:*)` for the lockfile's package manager (#360), if any. */
export async function loopAllowRules(dir: string): Promise<string[]> {
	const pm = await detectPackageManager(dir)
	return pm
		? [...LOOP_ALLOW_RULES.slice(0, 2), `Bash(${pm}:*)`, ...LOOP_ALLOW_RULES.slice(2)]
		: LOOP_ALLOW_RULES
}

/**
 * Deny rules written alongside the allow rules (#373). `Bash(git *)` and `Bash(<pm>:*)`
 * would otherwise grant `git -c alias.x='!<cmd>' x`, `git -c core.sshCommand=<cmd>`,
 * `pnpm dlx <any package>` and the like, which is arbitrary shell. Deny beats allow.
 * ponytail: prefix rules, so `git -C <dir> -c …` and `pnpm --filter x exec` still get past.
 * A `git -C * -c *` rule would also deny every commit whose message has " -c " in it,
 * because Claude Code's `*` spans spaces.
 */
export const LOOP_DENY_RULES = [
	'Bash(git -c *)',
	'Bash(git config *)',
	'Bash(git --config-env*)',
	'Bash(git --exec-path*)',
]

/** The subcommands that run a package the lockfile didn't install, or an arbitrary command. */
const PM_RUNNERS: Record<PackageManager, string[]> = {
	pnpm: ['dlx', 'exec', 'create'],
	npm: ['exec', 'x', 'create', 'init'],
	yarn: ['dlx', 'exec', 'create'],
	bun: ['x', 'exec', 'create'],
}

/** {@link LOOP_DENY_RULES} plus the lockfile's package manager's runners, if any. */
export async function loopDenyRules(dir: string): Promise<string[]> {
	const pm = await detectPackageManager(dir)
	return [...LOOP_DENY_RULES, ...(pm ? PM_RUNNERS[pm].map((sub) => `Bash(${pm} ${sub} *)`) : [])]
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

async function rules(file: string, key: 'allow' | 'deny'): Promise<string[]> {
	const settings = await fs.readJson(file).catch(() => null)
	return strings(settings?.permissions?.[key])
}

const present = async (dir: string, home: string, key: 'allow' | 'deny') =>
	new Set(
		(await Promise.all(settingsFiles(dir, home).map((f) => rules(f, key)))).flat().map(normalise)
	)

/**
 * The loop's allow and deny rules no settings file has yet; null when a bare `Bash`
 * allows everything, since the loop then grants nothing and adds no denies either.
 */
async function missingRules(
	dir: string,
	home: string
): Promise<{ allow: string[]; deny: string[]; legacy: string[] } | null> {
	const have = await present(dir, home, 'allow')
	// A bare `Bash` (or `Bash(*)`) allows every command.
	if (have.has('Bash') || have.has('Bash(*)')) return null
	const denied = await present(dir, home, 'deny')
	const allow = (await loopAllowRules(dir)).filter((r) => !have.has(normalise(r)))
	return {
		allow,
		deny: (await loopDenyRules(dir)).filter((r) => !denied.has(normalise(r))),
		legacy: allow.filter((r) => legacy(r) !== r && have.has(normalise(legacy(r)))),
	}
}

/**
 * `setup`'s allow-rules step (#371): merge the missing allow and deny rules into this
 * checkout's gitignored `.claude/settings.local.json`, so the grant covers only this
 * repo and is never committed. Appends only — existing rules and every other key stay
 * put. Logs each rule it adds; returns the files written.
 */
export async function fixAllowRules(dir: string, home: string): Promise<string[]> {
	const missing = await missingRules(dir, home)
	if (!missing || missing.allow.length + missing.deny.length === 0) {
		console.error("   the loop's allow rules are already present")
		return []
	}
	await assertNotSymlinked(dir)
	const file = path.join(dir, SETTINGS_LOCAL)
	let settings: Record<string, unknown> = {}
	if (await fs.pathExists(file)) {
		try {
			settings = await fs.readJson(file)
		} catch {
			throw new FixerAbort(
				'settings-local-unparseable',
				`${SETTINGS_LOCAL} is not valid JSON — not overwriting it`,
				`Fix the file by hand, or add ${missing.allow.map((r) => `"${r}"`).join(', ')} to permissions.allow and ${missing.deny.map((r) => `"${r}"`).join(', ')} to permissions.deny yourself`
			)
		}
	}
	const permissions = (settings.permissions ?? {}) as Record<string, unknown>
	await fs.outputJson(
		file,
		{
			...settings,
			permissions: {
				...permissions,
				allow: [...strings(permissions.allow), ...missing.allow],
				deny: [...strings(permissions.deny), ...missing.deny],
			},
		},
		{ spaces: 2 }
	)
	for (const rule of missing.allow) console.error(`   allowed ${rule}`)
	for (const rule of missing.deny) console.error(`   denied ${rule}`)
	const written = [SETTINGS_LOCAL]
	if (await ensureIgnored(dir)) written.push('.gitignore')
	return written
}

/** One result per missing rule, or a single `ok` when all are present. */
export async function checkAllowRules(dir: string, home: string): Promise<CheckResult[]> {
	const check = 'Claude Code permissions'
	const missing = await missingRules(dir, home)
	if (missing === null) {
		return [{ check, status: 'ok', detail: 'all Bash commands are allowed' }]
	}
	const hint = (rule: string, key: string) =>
		`Run \`npx @rtorcato/repo-ai fix allow-rules\` to add it to ${SETTINGS_LOCAL}, or add "${rule}" to permissions.${key} yourself`
	const allow = missing.allow.filter((r) => !missing.legacy.includes(r))
	if (allow.length + missing.deny.length === 0) {
		const [old] = missing.legacy
		return [
			old
				? {
						check,
						status: 'ok',
						detail: `the loop's rules are present, with "${legacy(old)}" from before the rename`,
						hint: hint(old, 'allow'),
					}
				: { check, status: 'ok', detail: "all of the loop's allow and deny rules are present" },
		]
	}
	return [
		...allow.map((rule) => ({
			check,
			status: 'drift' as const,
			detail: `no "${rule}" allow rule — the loop's calls will prompt or hit the auto-mode classifier`,
			hint: hint(rule, 'allow'),
		})),
		...missing.deny.map((rule) => ({
			check,
			status: 'drift' as const,
			detail: `no "${rule}" deny rule — the loop's broad git/package-manager grant lets that run any command`,
			hint: hint(rule, 'deny'),
		})),
	]
}

/**
 * With Claude Code's sandbox on, an allow rule only skips the prompt: the call
 * still runs sandboxed, where `gh` fails TLS (no keychain on macOS) and `npx`
 * can't write its cache (#257). These run the loop's own calls outside it.
 */
export const LOOP_SANDBOX_EXCLUDES = ['gh *', 'npx @rtorcato/repo-ai *']

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
	const missing = LOOP_SANDBOX_EXCLUDES.filter((c) => !have.has(c))
	return { enabledIn, missing, legacy: missing.filter((c) => have.has(legacy(c))) }
}

/** One `drift` per missing exclude while the sandbox is on; `ok` otherwise. */
export async function checkSandboxExcludes(dir: string, home: string): Promise<CheckResult[]> {
	const check = 'Claude Code sandbox'
	const { enabledIn, missing, legacy: old } = await readSandbox(dir, home)
	if (!enabledIn) return [{ check, status: 'ok', detail: 'sandbox is off' }]
	const hint = 'Run `npx @rtorcato/repo-ai fix sandbox`'
	const drifting = missing.filter((c) => !old.includes(c))
	if (drifting.length === 0) {
		const [first] = old
		return [
			first
				? {
						check,
						status: 'ok',
						detail: `the loop's calls are excluded from the sandbox, with "${legacy(first)}" from before the rename`,
						hint,
					}
				: { check, status: 'ok', detail: "the loop's calls are excluded from the sandbox" },
		]
	}
	return drifting.map((cmd) => ({
		check,
		status: 'drift',
		detail: `sandbox is on and "${cmd}" is not in sandbox.excludedCommands — the loop's calls run sandboxed and fail`,
		hint,
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
