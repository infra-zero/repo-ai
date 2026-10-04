import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { Task } from '../../daemon/queue.js'
import { runTask, type TaskResult, trailer } from '../../daemon/run-task.js'

/**
 * `repo-ai worker` (#283): one agent container's loop — pull a task from
 * the dashboard, run it with headless Claude Code, report back. Stateless:
 * the dashboard holds the queue and GitHub holds the state, so a worker can
 * be restarted or killed at any point.
 */

export interface WorkerOptions {
	url: string
	/** Defaults to the container hostname, which compose pins per service. */
	id?: string
	/** Test seams. */
	run?: typeof runTask
	fetch?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	/** Stop after this many loop turns; unset runs forever. */
	turns?: number
}

/** Under the default `staleMinutes` (45), so the run ends before `loop reap` releases its claim. */
const TASK_TIMEOUT_MS = 40 * 60_000
const IDLE_MS = 5_000
const BEAT_MS = 30_000

/** One line for the dashboard: the trailer the prompt asked for, else why it failed. */
export function summarize(kind: Task['kind'], r: TaskResult): string {
	if (r.error) return r.error
	const key = { implement: 'PR', review: 'VERDICT', fix: 'PUSHED' }[kind]
	const t = trailer(r.result, key)
	return t ? `${key} ${t}` : (r.result.trim().split('\n').at(-1) ?? '').slice(0, 200)
}

export async function workerCommand(o: WorkerOptions): Promise<void> {
	const id = o.id ?? os.hostname()
	const secret = process.env.REPO_AI_WORKER_SECRET ?? ''
	const claudeAuth = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY)
	const f = o.fetch ?? fetch
	const sleep = o.sleep ?? ((ms: number) => delay(ms))
	const run = o.run ?? runTask
	const post = (path: string, body: unknown = {}) =>
		f(`${o.url}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-repo-ai-worker': secret },
			body: JSON.stringify(body),
		})

	if (!secret)
		console.error('⚠ REPO_AI_WORKER_SECRET is unset: the dashboard will refuse this worker')
	if (!claudeAuth)
		console.error('⚠ no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY: tasks will fail')
	console.error(`worker ${id} → ${o.url}`)

	for (let turn = 0; o.turns === undefined || turn < o.turns; turn++) {
		try {
			await post(`/api/workers/${id}/heartbeat`, { claudeAuth })
			const res = await post(`/api/workers/${id}/next`)
			if (res.status !== 200) {
				if (res.status !== 204) console.error(`next: ${res.status}`)
				await sleep(IDLE_MS)
				continue
			}
			const { task, env } = (await res.json()) as { task: Task; env: Record<string, string> }
			console.error(`→ ${task.repo} #${task.number} ${task.label}`)
			const beat = setInterval(
				() => void post(`/api/workers/${id}/heartbeat`, { claudeAuth }).catch(() => {}),
				BEAT_MS
			)
			let r: TaskResult
			try {
				r = await run({
					prompt: task.prompt,
					cwd: task.cwd,
					env,
					timeoutMs: TASK_TIMEOUT_MS,
					onProgress: (line) =>
						void post(`/api/tasks/${task.id}/progress`, { line }).catch(() => {}),
				})
			} finally {
				clearInterval(beat)
			}
			const summary = summarize(task.kind, r)
			console.error(`${r.ok ? '✓' : '✗'} ${task.repo} #${task.number} ${task.label}: ${summary}`)
			await post(`/api/tasks/${task.id}/done`, {
				ok: r.ok,
				summary,
				costUsd: r.costUsd,
				outputTokens: r.outputTokens,
				error: r.error,
			})
		} catch (err) {
			console.error(`dashboard unreachable: ${(err as Error).message}`)
			await sleep(IDLE_MS * 2)
		}
	}
}
