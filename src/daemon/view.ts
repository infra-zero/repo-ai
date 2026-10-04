import type { DaemonConfig, RepoSettings } from './config.js'
import type { TaskRecord } from './history.js'
import type { Task, WorkerInfo } from './queue.js'
import type { LoopEvent, RepoState } from './scheduler.js'

/**
 * What `GET /api/state` returns (#291) — the contract between the headless
 * API and the dashboard app, which imports this type. Prompts never leave
 * the API; titles in `state.board` are already sanitized.
 */
export interface DashboardView {
	now: number
	config: DaemonConfig
	/** GitHub App credentials are present (never their values). */
	app: boolean
	workerSecret: boolean
	/** Names of the model credentials the api holds, for profiles to reference (#295). */
	credentials: string[]
	repos: (RepoSettings & { state: RepoState | null; nextTick: number })[]
	workers: (WorkerInfo & { online: boolean })[]
	tasks: Omit<Task, 'prompt'>[]
	events: LoopEvent[]
	/** Finished tasks, oldest first: the per-agent history (#296). */
	history: TaskRecord[]
	today: { tasks: number; outputTokens: number; costUsd: number }
}
