import type { GhExec } from './gh.js'

/**
 * `loop tick`/`doctor`'s CI-runs probe (#153). From v2: ~40 `main` push runs
 * of `ci.yml` sat pending on a stale required-reviewer approval and were
 * eventually cancelled with zero jobs — invisible, since neither state is a
 * failing check the send-back path already reports. This looks at the last 5
 * push runs of the CI workflow on `main` and names the run when the pattern
 * recurs: the latest completed one cancelled with no jobs, or the latest run
 * still pending with no jobs after {@link STUCK_MINUTES}.
 */

const STUCK_MINUTES = 30
// ponytail: the workflow file this tooling's own repos always use; add a
// config key if a consuming repo ever names its CI workflow something else.
const CI_WORKFLOW_SUFFIX = '/ci.yml'

interface RunApi {
	id: number
	status: string
	conclusion: string | null
	html_url: string
	created_at: string
	path?: string
}

async function jobCount(gh: GhExec, nwo: string, runId: number): Promise<number> {
	const r = await gh(['api', `repos/${nwo}/actions/runs/${runId}/jobs?per_page=1`])
	if (!r.ok) return -1 // unknown — never the basis for a warning
	try {
		const count = JSON.parse(r.stdout).total_count
		return typeof count === 'number' ? count : -1
	} catch {
		return -1
	}
}

/** `null` on any gh/parse failure or a healthy history — never the reason to halt. */
export async function ciRunWarning(gh: GhExec, nwo: string, now: number): Promise<string | null> {
	const r = await gh(['api', `repos/${nwo}/actions/runs?event=push&branch=main&per_page=5`])
	if (!r.ok) return null
	let runs: RunApi[]
	try {
		runs = (JSON.parse(r.stdout).workflow_runs ?? []) as RunApi[]
	} catch {
		return null
	}
	runs = runs.filter((run) => run.path?.endsWith(CI_WORKFLOW_SUFFIX))
	const [latest] = runs
	if (!latest) return null

	// The newest run, still stuck before any job started.
	if (latest.status !== 'completed') {
		const minutes = (now - Date.parse(latest.created_at)) / 60_000
		if (minutes > STUCK_MINUTES && (await jobCount(gh, nwo, latest.id)) === 0) {
			return `CI run pending with no jobs for ${Math.round(minutes)}m: ${latest.html_url}`
		}
	}

	// The newest *completed* run — checked even when a fresh run is already in
	// flight, so a still-running latest run doesn't mask the previous one
	// having been cancelled with nothing to show for it.
	const completed = runs.find((run) => run.status === 'completed')
	if (completed?.conclusion === 'cancelled' && (await jobCount(gh, nwo, completed.id)) === 0) {
		return `CI run cancelled with no jobs: ${completed.html_url}`
	}
	return null
}
