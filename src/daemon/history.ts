import type { Task } from './queue.js'

/** One finished task, kept in `tasks.jsonl` so per-agent history survives a restart (#296). */
export interface TaskRecord {
	t: number
	agent: string
	repo: string
	number: number
	label: string
	kind: Task['kind']
	runner: string
	model?: string
	ok: boolean
	/** The review marker the agent reported, else `DONE` / `FAILED`. */
	verdict: 'PASS' | 'PASS-NOTES' | 'CHANGES' | 'DONE' | 'FAILED'
	outputTokens: number
	costUsd: number
	durationMs: number
}

export const HISTORY_MAX = 500

/** Best effort: the verdict marker lives in a PR comment, so read it back from the agent's summary. */
export function toRecord(
	t: Task,
	profile: { runner?: string; model?: string } = {}
): TaskRecord | null {
	if (!t.result || !t.worker) return null
	const end = t.endedAt ?? Date.now()
	const m = /\b(PASS-NOTES|PASS|CHANGES)\b/.exec(t.result.summary)
	return {
		t: end,
		agent: t.worker,
		repo: t.repo,
		number: t.number,
		label: t.label,
		kind: t.kind,
		runner: profile.runner ?? 'claude',
		...(profile.model ? { model: profile.model } : {}),
		ok: t.result.ok,
		verdict: !t.result.ok
			? 'FAILED'
			: t.kind === 'review' && m
				? (m[1] as TaskRecord['verdict'])
				: 'DONE',
		outputTokens: t.result.outputTokens,
		costUsd: t.result.costUsd,
		durationMs: Math.max(0, end - (t.startedAt ?? end)),
	}
}

/** Parses `tasks.jsonl`, skipping any damaged line. */
export function parseHistory(text: string): TaskRecord[] {
	const out: TaskRecord[] = []
	for (const line of text.split('\n')) {
		try {
			const r = JSON.parse(line) as TaskRecord
			if (typeof r?.agent === 'string' && typeof r.t === 'number') out.push(r)
		} catch {}
	}
	return out.slice(-HISTORY_MAX)
}
