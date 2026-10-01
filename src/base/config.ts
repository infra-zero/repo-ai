/**
 * Loop config: `.repo-ai.json`, own file, repo-ai's to define (#38). It is the
 * only place config is read from (#159); `doctor` reports it missing and
 * `fix config` creates it.
 */
import path from 'node:path'
import fs from 'fs-extra'

export const CONFIG_FILE = '.repo-ai.json'
export type ConfigSource = 'repo-ai.json' | 'none'

export interface RepoAiConfig {
	agentUser?: string
	/** Overrides the owner-based default in `loop env`'s `humanUser` (#162) — needed on an organisation-owned repo, which has no owner user to fall back to. */
	humanUser?: string
	requiredSkills?: string[]
	/** `loop watch`'s poll interval, floored at {@link MIN_POLL_SECONDS}. */
	pollSeconds?: number
	/** Per-tick output-token cap for the `ai-loop-*` Workflow scripts (#41). */
	budgetTokens?: number
	/** Minutes of unchanged status before Pass 5 stops the loop (#124); `0` disables. */
	quietStopMinutes?: number
	/** Opt-in to unattended merges on a release-gated repo (#142); absent means off. */
	autoMerge?: boolean
	/** Issues in flight at once (#158). */
	maxInFlight?: number
	/** Fix rounds per PR; the round-cap block fires at `maxFixRounds + 1` `ai-changes` (#158). */
	maxFixRounds?: number
	/** Review/fix tasks per tick in `ai-loop-recover` (#158). */
	maxTasksPerTick?: number
	/** Minutes a claim label may sit before `loop reap` calls its agent dead (#158). */
	staleMinutes?: number
	/** `/ai-loop` job cadence while work is in flight (#158). */
	busyMinutes?: number
	/** `/ai-loop` job cadence when idle (#158). */
	idleMinutes?: number
	/** Minutes a Dependabot recreate may go unanswered before the PR is handed to a human (#255). */
	dependabotStallMinutes?: number
	/** Live agents across every Workflow, counted from claim labels; unset means no cap (#167). */
	maxAgents?: number
	/** The CI workflow file the `main` run probes watch (#201); unset means `ci.yml`. */
	ciWorkflow?: string
	source: ConfigSource
}

export function asLogin(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export const DEFAULT_POLL_SECONDS = 180
export const MIN_POLL_SECONDS = 60

// Each poll costs several GitHub API calls against the 5,000/h limit (#62).
function asPollSeconds(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.max(MIN_POLL_SECONDS, Math.floor(value))
		: undefined
}

export const DEFAULT_BUDGET_TOKENS = 400_000
const MIN_BUDGET_TOKENS = 1000

export const DEFAULT_QUIET_STOP_MINUTES = 120

/** Today's hard-coded limits, and the floor below which a configured value is ignored (#158). */
export const LIMITS = {
	maxInFlight: { default: 6, min: 1 },
	maxFixRounds: { default: 2, min: 0 },
	maxTasksPerTick: { default: 8, min: 1 },
	staleMinutes: { default: 45, min: 1 },
	busyMinutes: { default: 10, min: 1 },
	idleMinutes: { default: 30, min: 1 },
	/** Minutes a Dependabot recreate may go unanswered before the PR is handed to a human (#255). */
	dependabotStallMinutes: { default: 30, min: 1 },
} as const
export type LimitKey = keyof typeof LIMITS

function asAtLeast(value: unknown, min: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= min
		? Math.floor(value)
		: undefined
}

/** A limit's configured value, else its default. */
export function limit(config: RepoAiConfig | null, key: LimitKey): number {
	return config?.[key] ?? LIMITS[key].default
}

export function asSkillList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const names = value.filter((n): n is string => typeof n === 'string')
	// An empty list states no requirement — treat it the same as absent.
	return names.length > 0 ? names : undefined
}

/** `.repo-ai.json`, or `{ source: 'none' }` when it is missing or unreadable. */
export async function readConfig(dir: string): Promise<RepoAiConfig> {
	const own = await fs.readJson(path.join(dir, CONFIG_FILE)).catch(() => null)
	if (own) {
		return {
			agentUser: asLogin(own.agentUser),
			humanUser: asLogin(own.humanUser),
			requiredSkills: asSkillList(own.requiredSkills),
			pollSeconds: asPollSeconds(own.pollSeconds),
			budgetTokens: asAtLeast(own.budgetTokens, MIN_BUDGET_TOKENS),
			quietStopMinutes: asAtLeast(own.quietStopMinutes, 0),
			autoMerge: own.autoMerge === true,
			maxAgents: asAtLeast(own.maxAgents, 1),
			ciWorkflow: asLogin(own.ciWorkflow),
			...Object.fromEntries(
				Object.entries(LIMITS).map(([k, { min }]) => [k, asAtLeast(own[k], min)])
			),
			source: 'repo-ai.json',
		}
	}
	return { source: 'none' }
}
