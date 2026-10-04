import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'fs-extra'
import type { Task } from '../../daemon/queue.js'
import {
	agentEnv,
	agentIdentity,
	runTask,
	type TaskResult,
	trailer,
} from '../../daemon/run-task.js'

/**
 * `repo-ai worker` (#283): one agent container's loop — pull a task from
 * the dashboard, run it with headless Claude Code, report back. Stateless:
 * the dashboard holds the queue and GitHub holds the state, so a worker can
 * be restarted or killed at any point.
 *
 * Each task runs in a fresh clone of its own under `--work`, deleted after:
 * the worker never shares a git directory with the dashboard, whose git
 * runs beside the App key (#290 review).
 */

export interface WorkerOptions {
	url: string
	/** Defaults to the container hostname, which compose pins per service. */
	id?: string
	/** Where each task's clone goes. */
	work?: string
	/** Test seams. */
	run?: typeof runTask
	prepare?: typeof prepareCheckout
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SAFE_REF = /^(?!-)[\w./-]{1,200}$/

function exec(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	const id = agentIdentity()
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			env: { ...env, ...(id && { HOME: id.home }) },
			...(id && { uid: id.uid, gid: id.gid }),
			stdio: ['ignore', 'ignore', 'pipe'],
		})
		let err = ''
		child.stderr.on('data', (d) => {
			err = (err + d).slice(-500)
		})
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0
				? resolve()
				: reject(new Error(`${cmd} ${args[0]}: ${err.trim() || `exit ${code}`}`))
		)
	})
}

/** A fresh clone in `dir`, on the branch the task names. Returns the directory the agent runs in. */
export async function prepareCheckout(
	task: Task,
	dir: string,
	env: NodeJS.ProcessEnv
): Promise<string> {
	// /work stays root-owned, so the agent cannot plant a symlink at `dir`: drop any stale
	// leftover, create it fresh (mkdir fails on an existing entry), lchown only that dir (#293).
	await fs.remove(dir)
	await fs.mkdir(dir)
	const id = agentIdentity()
	if (id) await fs.lchown(dir, id.uid, id.gid)
	const c = task.checkout
	if (!c) return dir
	if (!/^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/.test(task.repo))
		throw new Error(`not an owner/repo: ${task.repo}`)
	if ('branch' in c && !(SAFE_REF.test(c.branch) && SAFE_REF.test(c.from)))
		throw new Error('unsafe branch name')
	await exec('git', ['clone', '--quiet', `https://github.com/${task.repo}.git`, dir], dir, env)
	if ('pr' in c) {
		await exec('gh', ['pr', 'checkout', String(c.pr)], dir, env)
	} else {
		await exec('git', ['checkout', '--quiet', '-B', c.branch, `origin/${c.from}`], dir, env)
	}
	return dir
}

export async function workerCommand(o: WorkerOptions): Promise<void> {
	const id = o.id ?? os.hostname()
	const secret = process.env.REPO_AI_WORKER_SECRET ?? ''
	const claudeAuth = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY)
	const f = o.fetch ?? fetch
	const sleep = o.sleep ?? ((ms: number) => delay(ms))
	const run = o.run ?? runTask
	const prepare = o.prepare ?? prepareCheckout
	const work = o.work ?? '/work'
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
			// Idle here: anything the dashboard still thinks this worker holds goes back in the queue.
			await post(`/api/workers/${id}/heartbeat`, { claudeAuth, busy: false })
			const res = await post(`/api/workers/${id}/next`)
			if (res.status !== 200) {
				if (res.status !== 204) console.error(`next: ${res.status}`)
				await sleep(IDLE_MS)
				continue
			}
			const { task, env } = (await res.json()) as { task: Task; env: Record<string, string> }
			console.error(`→ ${task.repo} #${task.number} ${task.label}`)
			const beat = setInterval(
				() => void post(`/api/workers/${id}/heartbeat`, { claudeAuth, busy: true }).catch(() => {}),
				BEAT_MS
			)
			const taskEnv = { ...env, GH_REPO: task.repo }
			// Root removes this directory (#293 review): only a UUID — what the api's
			// randomUUID makes — may name it, so a hostile id cannot point outside /work.
			const safeId = UUID.test(task.id)
			const dir = path.join(work, safeId ? task.id : 'rejected')
			let r: TaskResult
			try {
				if (!safeId) throw new Error('task id is not a UUID')
				const cwd = await prepare(task, dir, { ...agentEnv(process.env), ...taskEnv })
				r = await run({
					prompt: task.prompt,
					cwd,
					env: taskEnv,
					timeoutMs: TASK_TIMEOUT_MS,
					onProgress: (line) =>
						void post(`/api/tasks/${task.id}/progress`, { line }).catch(() => {}),
				})
			} catch (err) {
				r = {
					ok: false,
					result: '',
					costUsd: 0,
					outputTokens: 0,
					durationMs: 0,
					error: `checkout failed: ${(err as Error).message}`,
				}
			} finally {
				clearInterval(beat)
				await fs.remove(dir).catch(() => {})
			}
			const summary = summarize(task.kind, r)
			console.error(`${r.ok ? '✓' : '✗'} ${task.repo} #${task.number} ${task.label}: ${summary}`)
			const done = {
				ok: r.ok,
				summary,
				costUsd: r.costUsd,
				outputTokens: r.outputTokens,
				error: r.error,
			}
			// A lost `done` is recovered by the next idle heartbeat, but a retry usually saves the re-run.
			for (let attempt = 0; attempt < 3; attempt++) {
				const ok = await post(`/api/tasks/${task.id}/done`, done).then(
					(x) => x.ok,
					() => false
				)
				if (ok) break
				await sleep(2000 * (attempt + 1))
			}
		} catch (err) {
			console.error(`dashboard unreachable: ${(err as Error).message}`)
			await sleep(IDLE_MS * 2)
		}
	}
}
