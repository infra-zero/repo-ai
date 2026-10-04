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
}

export interface DaemonConfig {
	pollSeconds: number
	repos: RepoSettings[]
	/** Keyed by worker id (its container hostname). Unknown workers get `any`. */
	workers: Record<string, WorkerSettings>
}

export const DEFAULT_CONFIG: DaemonConfig = { pollSeconds: 180, repos: [], workers: {} }

const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/
const ROLES: Role[] = ['any', 'implementer', 'reviewer', 'fixer']

/** The config, or what is wrong with it. Input comes from the browser: trust nothing. */
export function validateConfig(input: unknown): DaemonConfig | string {
	const c = input as Partial<DaemonConfig> | null
	if (!c || typeof c !== 'object') return 'config must be an object'
	const pollSeconds = Number(c.pollSeconds ?? DEFAULT_CONFIG.pollSeconds)
	if (!Number.isInteger(pollSeconds) || pollSeconds < 60)
		return 'pollSeconds must be an integer ≥ 60'
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
		if (!/^[\w.-]{1,64}$/.test(id) || /^(__proto__|constructor|prototype)$/.test(id))
			return `not a worker id: ${id}`
		if (!ROLES.includes(w?.role)) return `${id}: role must be one of ${ROLES.join(', ')}`
		// A repo that is no longer configured drops out of the worker's list rather than refusing the
		// save — removing a repo would otherwise be impossible while any worker is scoped to it (#288 review).
		const wr = Array.isArray(w.repos)
			? w.repos.filter((x) => typeof x === 'string' && repos.some((r) => r.repo === x))
			: []
		workers[id] = { role: w.role, repos: wr }
	}
	return { pollSeconds, repos, workers }
}

export async function readDaemonConfig(file: string): Promise<DaemonConfig> {
	const raw = await fs.readJson(file).catch(() => null)
	const c = raw ? validateConfig(raw) : DEFAULT_CONFIG
	return typeof c === 'string' ? DEFAULT_CONFIG : c
}

export async function writeDaemonConfig(file: string, c: DaemonConfig): Promise<void> {
	await fs.outputJson(file, c, { spaces: 2 })
}
