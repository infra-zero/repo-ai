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
const CI_WORKFLOW = 'ci.yml'

interface RunApi {
	id: number
	status: string
	conclusion: string | null
	html_url: string
	created_at: string
}

/**
 * The last 5 push runs of {@link CI_WORKFLOW} on `branch` (the repo's default
 * branch, #179), newest first, or `null` on any gh/parse failure or an
 * unresolved branch. Workflow-scoped (#174): listing `actions/runs` and
 * filtering client-side let other push-to-main workflows (e.g. `docs.yml`)
 * crowd `ci.yml` runs out of the 5-run window.
 */
async function ciRuns(gh: GhExec, nwo: string, branch: string): Promise<RunApi[] | null> {
	if (!branch) return null
	const r = await gh([
		'api',
		`repos/${nwo}/actions/workflows/${CI_WORKFLOW}/runs?event=push&branch=${encodeURIComponent(branch)}&per_page=5`,
	])
	if (!r.ok) return null
	try {
		return (JSON.parse(r.stdout).workflow_runs ?? []) as RunApi[]
	} catch {
		return null
	}
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
export async function ciRunWarning(
	gh: GhExec,
	nwo: string,
	branch: string,
	now: number
): Promise<string | null> {
	const runs = await ciRuns(gh, nwo, branch)
	const [latest] = runs ?? []
	if (!runs || !latest) return null

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

/**
 * The `run_attempt` of a single workflow run — `loop tick`'s ci-red path uses
 * it to tell a first failure (worth one free `gh run rerun --failed`, #202)
 * from a failure that already survived a rerun. `null` on any gh/parse
 * failure, so the caller falls back to its old, safe behaviour: send back.
 */
export async function runAttempt(gh: GhExec, nwo: string, runId: number): Promise<number | null> {
	const r = await gh(['api', `repos/${nwo}/actions/runs/${runId}`])
	if (!r.ok) return null
	try {
		const attempt = JSON.parse(r.stdout).run_attempt
		return typeof attempt === 'number' ? attempt : null
	} catch {
		return null
	}
}

const RELEASE_STUCK_HOURS = 24

/**
 * `loop tick`/`doctor`'s release-approval probe (#146). A `release` job
 * waiting on the `release` environment's approval pins the `main` push
 * concurrency group: every later merge's run queues behind it and gets
 * cancelled with zero jobs the moment a newer one lands, invisible because a
 * cancelled run isn't a failing check. Reports a run only once it has sat
 * `waiting` for over a day — the loop never approves or cancels it.
 */
export async function releaseStuckWarning(
	gh: GhExec,
	nwo: string,
	branch: string,
	now: number
): Promise<string | null> {
	const waiting = (await ciRuns(gh, nwo, branch))?.find((run) => run.status === 'waiting')
	if (!waiting) return null
	const hours = (now - Date.parse(waiting.created_at)) / 3_600_000
	if (hours <= RELEASE_STUCK_HOURS) return null
	return `release run ${waiting.id} waiting on approval for ${Math.round(hours)}h: ${waiting.html_url}`
}
