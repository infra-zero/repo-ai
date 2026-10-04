import fs from 'fs-extra'
import type { Role } from './queue.js'
import { type RunnerName, runners } from './run-task.js'

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
	/** For the UI; the worker's `--runner` decides what actually runs (#294). */
	runner?: RunnerName
	/** Passed to the runner's `--model`; unset uses its default. */
	model?: string
	/**
	 * Names of the api's model credentials this worker's tasks get, never values
	 * (see `MODEL_CREDENTIAL`). Empty: the worker's own env, as before #295.
	 */
	credentials?: string[]
	/** Daily spend target in USD, shown on the agent's card; not enforced. */
	budgetUsd?: number
	/** Claude Code `--allowedTools` rules; set, everything else is denied. Empty: all tools. */
	tools?: string[]
}

/** Global loop limits (#302); unset means the repo's own `.repo-ai.json` / built-in default. */
export interface GlobalLimits {
	maxInFlight?: number
	maxFixRounds?: number
	/** Output tokens per day; 0 or unset: no budget. */
	tokenBudget?: number
}

/**
 * An MCP server a runner may use (#306). The owner enters the command here: the
 * config is the allowlist, and a task never supplies one.
 */
export interface McpServer {
	name: string
	/** stdio: the executable, and its args. */
	command?: string
	args?: string[]
	/** Or remote: an http(s) URL. */
	url?: string
	/** Names of the api's `MCP_*` credentials the server reads, never values. */
	env?: string[]
	enabled: boolean
	/** Worker ids that may use it. Empty: none. */
	agents: string[]
}

/** One runner's entry in the Models section (#306). */
export interface ModelSettings {
	/** Model ids a profile may pick. */
	models?: string[]
	/** `--model` for a profile that sets none. */
	defaultModel?: string
	/** Tool allowlist for a profile that sets none. */
	tools?: string[]
	/** Network / filesystem access notes, for people. */
	notes?: string
	/** Labels for credential names, e.g. two Claude subscriptions. */
	accounts?: { name: string; credential: string }[]
	mcp?: McpServer[]
}

export interface DaemonConfig extends GlobalLimits {
	pollSeconds: number
	repos: RepoSettings[]
	/** Keyed by worker id (its container hostname). Unknown workers get `any`. */
	workers: Record<string, WorkerSettings>
	/** Keyed by runner. */
	models?: Partial<Record<RunnerName, ModelSettings>>
}

export const DEFAULT_CONFIG: DaemonConfig = { pollSeconds: 180, repos: [], workers: {} }

const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/
const ROLES: Role[] = ['any', 'implementer', 'reviewer', 'fixer']

/**
 * The only env names a profile may hand a task: a model credential, optionally
 * suffixed to name an account (`ANTHROPIC_API_KEY_TEAM`). Anything else in the
 * api's env — the worker secret, the App key — can never be named. Group 1 is
 * the name the runner reads.
 */
export const MODEL_CREDENTIAL = new RegExp(
	`^(${Object.values(runners)
		.flatMap((r) => r.auth)
		.join('|')})(?:_[A-Z0-9]{1,32})?$`
)
/** The only env names an MCP server may be handed (#306): never a model, worker or App secret. */
export const MCP_CREDENTIAL = /^MCP_[A-Z0-9_]{1,64}$/
const RUNNER_NAMES = Object.keys(runners) as RunnerName[]
const WORKER_ID = /^[\w.-]{1,64}$/
const NAME = /^[A-Za-z0-9][\w-]{0,39}$/
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
		if (!RUNNER_NAMES.includes(w.runner as RunnerName))
			return `${id}: runner must be one of ${RUNNER_NAMES.join(', ')}`
		p.runner = w.runner as RunnerName
	}
	if (w.model !== undefined && w.model !== '') {
		if (typeof w.model !== 'string' || !MODEL.test(w.model)) return `${id}: not a model name`
		p.model = w.model
	}
	if (w.budgetUsd !== undefined && w.budgetUsd !== '' && w.budgetUsd !== null) {
		if (typeof w.budgetUsd !== 'number' || !(w.budgetUsd > 0) || w.budgetUsd > 100000)
			return `${id}: budgetUsd must be a positive number`
		p.budgetUsd = w.budgetUsd
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
	const workers: Record<string, WorkerSettings> = {}
	for (const [id, w] of Object.entries(c.workers ?? {})) {
		if (!WORKER_ID.test(id) || /^(__proto__|constructor|prototype)$/.test(id))
			return `not a worker id: ${id}`
		if (!ROLES.includes(w?.role)) return `${id}: role must be one of ${ROLES.join(', ')}`
		// A repo that is no longer configured drops out of the worker's list rather than refusing the
		// save — removing a repo would otherwise be impossible while any worker is scoped to it (#288 review).
		const wr = Array.isArray(w.repos)
			? w.repos.filter((x) => typeof x === 'string' && repos.some((r) => r.repo === x))
			: []
		const profile = validateProfile(id, w as unknown as Record<string, unknown>)
		if (typeof profile === 'string') return profile
		workers[id] = { role: w.role, repos: wr, ...profile }
	}
	const models: Partial<Record<RunnerName, ModelSettings>> = {}
	for (const [runner, m] of Object.entries(c.models ?? {})) {
		if (!RUNNER_NAMES.includes(runner as RunnerName)) return `not a runner: ${runner}`
		const v = validateModel(runner as RunnerName, m as Record<string, unknown>)
		if (typeof v === 'string') return `${runner}: ${v}`
		models[runner as RunnerName] = v
	}
	return { pollSeconds, ...limits, repos, workers, ...(Object.keys(models).length && { models }) }
}

/** A list of strings each matching `re`, deduped, or what is wrong. */
function list(v: unknown, re: RegExp, what: string, max = 50): string[] | string {
	if (v === undefined) return []
	if (!Array.isArray(v) || v.length > max) return `${what} must be a list`
	for (const x of v) if (typeof x !== 'string' || !re.test(x)) return `not ${what}: ${String(x)}`
	return [...new Set(v as string[])]
}

const TEXT = (max: number) => new RegExp(`^[^\\p{Cc}]{1,${max}}$`, 'u')

/** One runner's Models entry (#306), or what is wrong with it. */
function validateModel(runner: RunnerName, m: Record<string, unknown>): ModelSettings | string {
	if (!m || typeof m !== 'object') return 'must be an object'
	const out: ModelSettings = {}
	const models = list(m.models, MODEL, 'a model name')
	if (typeof models === 'string') return models
	if (models.length) out.models = models
	if (m.defaultModel !== undefined && m.defaultModel !== '') {
		if (typeof m.defaultModel !== 'string' || !MODEL.test(m.defaultModel)) return 'not a model name'
		out.defaultModel = m.defaultModel
	}
	const tools = list(m.tools, TOOL, 'a tool rule')
	if (typeof tools === 'string') return tools
	if (tools.length) {
		if (!runners[runner].allowlist) return `${runner} cannot enforce a tool allowlist`
		out.tools = tools
	}
	if (m.notes !== undefined && m.notes !== '') {
		if (typeof m.notes !== 'string' || m.notes.length > 1000) return 'notes: up to 1000 characters'
		out.notes = m.notes
	}
	if (m.accounts !== undefined) {
		if (!Array.isArray(m.accounts) || m.accounts.length > 20) return 'accounts must be a list'
		const accounts = []
		for (const a of m.accounts as Record<string, unknown>[]) {
			if (typeof a?.name !== 'string' || !TEXT(40).test(a.name))
				return 'account name: up to 40 characters'
			const base = typeof a.credential === 'string' && MODEL_CREDENTIAL.exec(a.credential)?.[1]
			if (!base || !runners[runner].auth.includes(base))
				return `not a ${runner} credential: ${String(a.credential)}`
			accounts.push({ name: a.name, credential: a.credential as string })
		}
		if (accounts.length) out.accounts = accounts
	}
	if (m.mcp !== undefined) {
		if (!Array.isArray(m.mcp) || m.mcp.length > 20) return 'mcp must be a list'
		const mcp: McpServer[] = []
		for (const x of m.mcp as Record<string, unknown>[]) {
			const s = validateMcp(x)
			if (typeof s === 'string') return s
			if (mcp.some((y) => y.name === s.name)) return `mcp ${s.name} is listed twice`
			mcp.push(s)
		}
		if (mcp.length && !runners[runner].mcp) return `${runner} cannot take MCP servers yet`
		if (mcp.length) out.mcp = mcp
	}
	return out
}

function validateMcp(x: Record<string, unknown>): McpServer | string {
	if (typeof x?.name !== 'string' || !NAME.test(x.name))
		return `not an MCP server name: ${String(x?.name)}`
	const s: McpServer = { name: x.name, enabled: x.enabled === true, agents: [] }
	const hasCommand = x.command !== undefined && x.command !== ''
	const hasUrl = x.url !== undefined && x.url !== ''
	if (hasCommand === hasUrl) return `mcp ${s.name}: set a command or a URL`
	if (hasCommand) {
		// An executable name or path, never a flag or a shell line.
		if (typeof x.command !== 'string' || !/^(?!-)[\w./@+-]{1,200}$/.test(x.command))
			return `mcp ${s.name}: not a command: ${String(x.command)}`
		s.command = x.command
		const args = list(x.args, TEXT(500), 'an argument', 30)
		if (typeof args === 'string') return `mcp ${s.name}: ${args}`
		// Not deduped: `-y pkg -y` is a legitimate order-dependent list.
		if (args.length) s.args = (x.args as string[]).slice()
	} else {
		let u: URL | null = null
		try {
			u = new URL(String(x.url))
		} catch {}
		if (!u || !/^https?:$/.test(u.protocol) || String(x.url).length > 500)
			return `mcp ${s.name}: not an http(s) URL`
		s.url = String(x.url)
	}
	const env = list(x.env, MCP_CREDENTIAL, 'an MCP_ credential name')
	if (typeof env === 'string') return `mcp ${s.name}: ${env}`
	if (env.length) s.env = env
	const agents = list(x.agents, WORKER_ID, 'a worker id', 200)
	if (typeof agents === 'string') return `mcp ${s.name}: ${agents}`
	s.agents = agents
	return s
}

/** The enabled MCP servers `worker` may use under `runner`. */
export function mcpFor(c: DaemonConfig, runner: RunnerName, worker: string): McpServer[] {
	return (c.models?.[runner]?.mcp ?? []).filter((s) => s.enabled && s.agents.includes(worker))
}

/** The env for MCP servers' named credentials, as-is. Throws on one the api does not have. */
export function mcpEnv(servers: McpServer[], env: NodeJS.ProcessEnv = process.env) {
	const out: Record<string, string> = {}
	for (const n of servers.flatMap((s) => s.env ?? [])) {
		const value = env[n]?.trim()
		if (!MCP_CREDENTIAL.test(n)) throw new Error(`not an MCP credential: ${n}`)
		if (!value) throw new Error(`credential ${n} is not set on the api`)
		out[n] = value
	}
	return out
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

/** Which model (or, with `re`, MCP) credentials the api holds — names only, for the dashboard. */
export function presentCredentials(
	env: NodeJS.ProcessEnv = process.env,
	re: RegExp = MODEL_CREDENTIAL
): string[] {
	return Object.keys(env)
		.filter((k) => re.test(k) && env[k]?.trim())
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
