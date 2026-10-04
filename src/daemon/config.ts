import fs from 'fs-extra'
import type { Role } from './queue.js'

/**
 * What the dashboard's setup screen edits (#282), kept in `/data/config.json`.
 * Per-repo loop limits stay where they already live: each repo's own
 * `.repo-ai.json`, which the tick reads from the clone.
 */

export interface RepoSettings {
	repo: string
	enabled: boolean
	/** Label new Dependabot PRs `ai-review` so the loop reviews them (#240). */
	dependabotAutoReview: boolean
}

export interface WorkerSettings {
	role: Role
	/** Empty: every repo. */
	repos: string[]
	/** Profile (#295): for the UI. */
	name?: string
	/** `#rrggbb`. */
	color?: string
	/** A short text badge — an emoji or initials, never a URL. */
	avatar?: string
	/** Only Claude Code until pluggable runners (#294). */
	runner?: 'claude'
	/** Passed to the runner's `--model`; unset uses its default. */
	model?: string
	/**
	 * Names of the api's model credentials this worker's tasks get, never values
	 * (see `MODEL_CREDENTIAL`). Empty: the worker's own env, as before #295.
	 */
	credentials?: string[]
	/** Claude Code `--allowedTools` rules; set, everything else is denied. Empty: all tools. */
	tools?: string[]
}

/**
 * An agent (#307): a profile with its own id, bound to one worker slot. Compose
 * runs N generic worker containers; a slot with no agent bound takes no tasks.
 */
export interface AgentSettings extends WorkerSettings {
	id: string
	/** The worker id (container hostname) it runs on. One agent per slot. */
	slot: string
	/** How long its worker waits between asks when idle, in seconds; unset: 5. */
	pollSeconds?: number
	/** Output tokens per day; unset: no budget. Over it, the agent takes no new task until tomorrow. */
	tokenBudget?: number
	/** USD per day; unset: no budget. */
	costBudgetUsd?: number
}

/** Global loop limits (#302); unset means the repo's own `.repo-ai.json` / built-in default. */
export interface GlobalLimits {
	maxInFlight?: number
	maxFixRounds?: number
	/** Output tokens per day; 0 or unset: no budget. */
	tokenBudget?: number
}

export interface DaemonConfig extends GlobalLimits {
	pollSeconds: number
	repos: RepoSettings[]
	agents: AgentSettings[]
}

export const DEFAULT_CONFIG: DaemonConfig = { pollSeconds: 180, repos: [], agents: [] }
const ID = /^[\w.-]{1,64}$/

const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/
const ROLES: Role[] = ['any', 'implementer', 'reviewer', 'fixer']

/**
 * The only env names a profile may hand a task: a model credential, optionally
 * suffixed to name an account (`ANTHROPIC_API_KEY_TEAM`). Anything else in the
 * api's env — the worker secret, the App key — can never be named. Group 1 is
 * the name the runner reads.
 */
export const MODEL_CREDENTIAL = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)(?:_[A-Z0-9]{1,32})?$/
const MODEL = /^[A-Za-z0-9][\w.:[\]-]{0,99}$/
/** A tool name with an optional rule: `Read`, `Bash(git *)`, `mcp__server__tool`. Never starts with `-`; no comma, since the list is passed comma-joined. */
const TOOL = /^[A-Za-z][\w-]{0,99}(\([^(),\n\r]{1,200}\))?$/

/** The profile fields of a worker, or what is wrong with them. */
function validateProfile(id: string, w: Record<string, unknown>): Partial<WorkerSettings> | string {
	const p: Partial<WorkerSettings> = {}
	if (w.name !== undefined && w.name !== '') {
		if (typeof w.name !== 'string' || w.name.length > 40 || /[\p{Cc}]/u.test(w.name))
			return `${id}: name must be up to 40 characters`
		p.name = w.name
	}
	if (w.color !== undefined && w.color !== '') {
		if (typeof w.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(w.color))
			return `${id}: color must be #rrggbb`
		p.color = w.color
	}
	if (w.avatar !== undefined && w.avatar !== '') {
		if (typeof w.avatar !== 'string' || w.avatar.length > 8 || /[\p{Cc}\s/:]/u.test(w.avatar))
			return `${id}: avatar must be an emoji or up to 8 characters`
		p.avatar = w.avatar
	}
	if (w.runner !== undefined && w.runner !== '') {
		if (w.runner !== 'claude') return `${id}: runner must be claude`
		p.runner = w.runner
	}
	if (w.model !== undefined && w.model !== '') {
		if (typeof w.model !== 'string' || !MODEL.test(w.model)) return `${id}: not a model name`
		p.model = w.model
	}
	for (const [key, re, what] of [
		['credentials', MODEL_CREDENTIAL, 'a model credential name'],
		['tools', TOOL, 'a tool rule'],
	] as const) {
		const v = w[key]
		if (v === undefined) continue
		if (!Array.isArray(v) || v.length > 50) return `${id}: ${key} must be a list`
		for (const x of v)
			if (typeof x !== 'string' || !re.test(x)) return `${id}: not ${what}: ${String(x)}`
		if (v.length) p[key] = [...new Set(v as string[])]
	}
	const bases = (p.credentials ?? []).map((c) => MODEL_CREDENTIAL.exec(c)?.[1])
	if (new Set(bases).size < bases.length)
		return `${id}: name at most one credential of each kind (the runner reads only one)`
	return p
}

/** The config, or what is wrong with it. Input comes from the browser: trust nothing. */
export function validateConfig(input: unknown): DaemonConfig | string {
	const c = input as Partial<DaemonConfig> | null
	if (!c || typeof c !== 'object') return 'config must be an object'
	const pollSeconds = Number(c.pollSeconds ?? DEFAULT_CONFIG.pollSeconds)
	if (!Number.isInteger(pollSeconds) || pollSeconds < 60)
		return 'pollSeconds must be an integer ≥ 60'
	const limits: GlobalLimits = {}
	for (const [key, min] of [
		['maxInFlight', 1],
		['maxFixRounds', 0],
		['tokenBudget', 0],
	] as const) {
		const v = c[key]
		if (v === undefined || v === null) continue
		if (!Number.isInteger(v) || v < min) return `${key} must be an integer ≥ ${min}`
		limits[key] = v
	}
	if (!Array.isArray(c.repos)) return 'repos must be a list'
	const repos: RepoSettings[] = []
	for (const r of c.repos) {
		if (typeof r?.repo !== 'string' || !REPO.test(r.repo))
			return `not an owner/repo: ${String(r?.repo)}`
		if (repos.some((x) => x.repo === r.repo)) return `${r.repo} is listed twice`
		repos.push({
			repo: r.repo,
			enabled: r.enabled !== false,
			dependabotAutoReview: r.dependabotAutoReview === true,
		})
	}
	// Before #307 profiles were keyed by worker id: each becomes an agent bound to that worker.
	const raw =
		c.agents ??
		Object.entries((c as { workers?: Record<string, unknown> }).workers ?? {}).map(([id, w]) => ({
			...(w as object),
			id,
			slot: id,
		}))
	if (!Array.isArray(raw) || raw.length > 100) return 'agents must be a list'
	const agents: AgentSettings[] = []
	for (const a of raw as AgentSettings[]) {
		if (!a || typeof a !== 'object') return 'each agent must be an object'
		const id = String(a?.id)
		if (!ID.test(id)) return `not an agent id: ${id}`
		if (typeof a.slot !== 'string' || !ID.test(a.slot)) return `${id}: not a worker slot`
		if (agents.some((x) => x.id === id)) return `agent ${id} is listed twice`
		const twin = agents.find((x) => x.slot === a.slot)
		if (twin) return `${id}: slot ${a.slot} is already ${twin.id}'s`
		if (!ROLES.includes(a.role)) return `${id}: role must be one of ${ROLES.join(', ')}`
		// A repo that is no longer configured drops out of the agent's list rather than refusing the
		// save — removing a repo would otherwise be impossible while any agent is scoped to it (#288 review).
		const ar = Array.isArray(a.repos)
			? a.repos.filter((x) => typeof x === 'string' && repos.some((r) => r.repo === x))
			: []
		const profile = validateProfile(id, a as unknown as Record<string, unknown>)
		if (typeof profile === 'string') return profile
		const over: Partial<AgentSettings> = {}
		for (const [key, ok, what] of [
			[
				'pollSeconds',
				(v: number) => Number.isInteger(v) && v >= 1 && v <= 600,
				'whole seconds, 1–600',
			],
			['tokenBudget', (v: number) => Number.isInteger(v) && v >= 0, 'an integer ≥ 0'],
			['costBudgetUsd', (v: number) => Number.isFinite(v) && v >= 0, 'a number ≥ 0'],
		] as const) {
			const v = a[key]
			if (v === undefined || v === null) continue
			if (typeof v !== 'number' || !ok(v)) return `${id}: ${key} must be ${what}`
			over[key] = v
		}
		agents.push({ id, slot: a.slot, role: a.role, repos: ar, ...profile, ...over })
	}
	return { pollSeconds, ...limits, repos, agents }
}

/**
 * The env a task gets for its worker's named credentials, each under the name
 * the runner reads. Throws on one the api does not have, so the task fails
 * visibly rather than running on the worker's own account.
 */
export function credentialEnv(
	names: string[] | undefined,
	env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const n of names ?? []) {
		const base = MODEL_CREDENTIAL.exec(n)?.[1]
		const value = env[n]?.trim()
		if (!base) throw new Error(`not a model credential: ${n}`)
		if (!value) throw new Error(`credential ${n} is not set on the api`)
		out[base] = value
	}
	return out
}

/** Which model credentials the api holds — names only, for the dashboard. */
export function presentCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
	return Object.keys(env)
		.filter((k) => MODEL_CREDENTIAL.test(k) && env[k]?.trim())
		.sort()
}

export async function readDaemonConfig(file: string): Promise<DaemonConfig> {
	const raw = await fs.readJson(file).catch(() => null)
	const c = raw ? validateConfig(raw) : DEFAULT_CONFIG
	return typeof c === 'string' ? DEFAULT_CONFIG : c
}

export async function writeDaemonConfig(file: string, c: DaemonConfig): Promise<void> {
	await fs.outputJson(file, c, { spaces: 2 })
}
