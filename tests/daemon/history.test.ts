import { describe, expect, it } from 'vitest'
import { parseHistory, toRecord } from '../../src/daemon/history.js'
import type { Task } from '../../src/daemon/queue.js'

const task = (o: Partial<Task>): Task => ({
	id: 'x',
	repo: 'a/b',
	kind: 'review',
	number: 1,
	label: 'review:code',
	prompt: '',
	checkout: null,
	state: 'done',
	createdAt: 0,
	worker: 'w1',
	startedAt: 1000,
	endedAt: 4000,
	result: { ok: true, summary: 'verdict CHANGES posted', costUsd: 0.5, outputTokens: 10 },
	...o,
})

describe('task history', () => {
	it('reads the verdict from a review summary and times the task', () => {
		expect(toRecord(task({}), { model: 'm' })).toMatchObject({
			verdict: 'CHANGES',
			durationMs: 3000,
			agent: 'w1',
			runner: 'claude',
			model: 'm',
		})
	})
	it('marks failures and non-reviews', () => {
		expect(
			toRecord(task({ result: { ok: false, summary: 'PASS', costUsd: 0, outputTokens: 0 } }))
				?.verdict
		).toBe('FAILED')
		expect(toRecord(task({ kind: 'implement' }))?.verdict).toBe('DONE')
		expect(toRecord(task({ worker: undefined }))).toBeNull()
	})
	it('skips damaged lines', () => {
		const r = toRecord(task({}))
		expect(parseHistory(`${JSON.stringify(r)}\n{bad\n`)).toHaveLength(1)
	})
})
