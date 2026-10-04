import { randomUUID } from 'node:crypto'

/**
 * The work queue between the dashboard's scheduler and the worker containers
 * (#282). In memory: the GitHub labels are the durable state, so a restart
 * loses only queued tasks, whose claim labels `loop reap` releases after
 * `staleMinutes` and the next tick claims again.
 */

export type TaskKind = 'implement' | 'review' | 'fix'
export type Role = 'any' | 'implementer' | 'reviewer' | 'fixer'

const ROLE_KIND: Record<Exclude<Role, 'any'>, TaskKind> = {
	implementer: 'implement',
	reviewer: 'review',
	fixer: 'fix',
}

export interface Task {
	id: string
	repo: string
	kind: TaskKind
	/** The issue (implement) or PR (review, fix). */
	number: number
	/** Shown on the dashboard, e.g. `review:code`. */
	label: string
	prompt: string
	/**
	 * What the worker checks out in its own fresh clone — never a path in the
	 * dashboard's clones, whose git runs beside the App key and must not be
	 * writable by an agent (#290 review). `null`: no checkout (a review reads via gh).
	 */
	checkout: { branch: string; from: string } | { pr: number } | null
	state: 'queued' | 'running' | 'done' | 'failed'
	createdAt: number
	worker?: string
	startedAt?: number
	endedAt?: number
	progress?: string
	result?: { ok: boolean; summary: string; costUsd: number; outputTokens: number; error?: string }
}

export interface WorkerInfo {
	id: string
	role: Role
	/** Empty: every configured repo. */
	repos: string[]
	lastSeen: number
	task?: string
	/** The worker has a Claude credential (it reports this; the dashboard never sees the value). */
	claudeAuth?: boolean
	/** The agent CLI it runs (#294), as it reports it. */
	runner?: string
}

export class Queue {
	readonly tasks = new Map<string, Task>()
	readonly workers = new Map<string, WorkerInfo>()

	constructor(
		/** A running task whose worker is silent this long goes back in the queue. */
		private readonly heartbeatMs = 90_000,
		private readonly now: () => number = Date.now
	) {}

	/** Adds a task unless the same work is already queued or running. */
	enqueue(t: Omit<Task, 'id' | 'state' | 'createdAt'>): Task | null {
		for (const x of this.tasks.values()) {
			if (
				(x.state === 'queued' || x.state === 'running') &&
				x.repo === t.repo &&
				x.label === t.label &&
				x.number === t.number
			)
				return null
		}
		const task: Task = { ...t, id: randomUUID(), state: 'queued', createdAt: this.now() }
		this.tasks.set(task.id, task)
		return task
	}

	heartbeat(
		id: string,
		assign: (id: string) => Pick<WorkerInfo, 'role' | 'repos'>,
		claudeAuth?: boolean,
		/** `false` from a worker between tasks: whatever it held is gone (a failed `done`, a restart). */
		busy?: boolean
	): WorkerInfo {
		// Re-read every beat, so a role changed on the dashboard applies from the worker's next task.
		const w: WorkerInfo = Object.assign(this.workers.get(id) ?? { id, lastSeen: 0 }, assign(id))
		w.lastSeen = this.now()
		if (claudeAuth !== undefined) w.claudeAuth = claudeAuth
		if (busy === false && w.task) this.release(w)
		this.workers.set(id, w)
		return w
	}

	/** The oldest queued task this worker's role and repos allow, now running on it. */
	next(id: string): Task | null {
		this.requeueStale()
		const w = this.workers.get(id)
		if (!w || w.task) return null
		const fits = (t: Task) =>
			t.state === 'queued' &&
			(w.role === 'any' || ROLE_KIND[w.role] === t.kind) &&
			(w.repos.length === 0 || w.repos.includes(t.repo))
		const task = [...this.tasks.values()].filter(fits).sort((a, b) => a.createdAt - b.createdAt)[0]
		if (!task) return null
		Object.assign(task, { state: 'running', worker: id, startedAt: this.now() })
		w.task = task.id
		return task
	}

	progress(taskId: string, line: string): boolean {
		const t = this.tasks.get(taskId)
		if (t?.state !== 'running') return false
		t.progress = line
		const w = t.worker ? this.workers.get(t.worker) : undefined
		if (w) w.lastSeen = this.now()
		return true
	}

	done(taskId: string, result: NonNullable<Task['result']>): Task | null {
		const t = this.tasks.get(taskId)
		if (t?.state !== 'running') return null
		Object.assign(t, { state: result.ok ? 'done' : 'failed', result, endedAt: this.now() })
		const w = t.worker ? this.workers.get(t.worker) : undefined
		if (w?.task === taskId) w.task = undefined
		this.prune()
		return t
	}

	requeueStale(): void {
		const cutoff = this.now() - this.heartbeatMs
		for (const w of this.workers.values()) if (w.lastSeen < cutoff && w.task) this.release(w)
	}

	/** The worker's task goes back in the queue. */
	private release(w: WorkerInfo): void {
		const t = w.task ? this.tasks.get(w.task) : undefined
		if (t?.state === 'running')
			Object.assign(t, { state: 'queued', worker: undefined, startedAt: undefined })
		w.task = undefined
	}

	/** Keeps the last 100 finished tasks for the dashboard. */
	private prune(): void {
		const finished = [...this.tasks.values()]
			.filter((t) => t.state === 'done' || t.state === 'failed')
			.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
		for (const t of finished.slice(100)) this.tasks.delete(t.id)
	}
}
