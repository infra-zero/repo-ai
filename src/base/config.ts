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

function asBudgetTokens(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= MIN_BUDGET_TOKENS
		? Math.floor(value)
		: undefined
}

export const DEFAULT_QUIET_STOP_MINUTES = 120

function asQuietStopMinutes(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined
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
			budgetTokens: asBudgetTokens(own.budgetTokens),
			quietStopMinutes: asQuietStopMinutes(own.quietStopMinutes),
			autoMerge: own.autoMerge === true,
			source: 'repo-ai.json',
		}
	}
	return { source: 'none' }
}
