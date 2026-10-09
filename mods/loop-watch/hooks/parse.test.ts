import { expect, test } from 'claude-code/testing'

import { agentIcon, aiItems, describeCall, isMergeReady, parseStatus } from './parse'

test('parses summary, next tick and staleness', () => {
	expect(parseStatus('2 in flight\n\n1600\n', 1000, 1000)).toEqual({
		summary: '2 in flight',
		next: 'next 10m',
		isStale: false,
	})
	expect(parseStatus('idle\n\n900', 1000, 1000)?.next).toBe('tick due')
	expect(parseStatus('stopped·user\n', 0, 5000)).toEqual({
		summary: 'stopped·user',
		next: '',
		isStale: true,
	})
	expect(parseStatus('\n', 0, 0)).toBe(null)
})

test('keeps only ai-* labelled items and spots merge-ready', () => {
	const items = aiItems('pr', [
		{
			number: 1,
			title: 'a',
			labels: [{ name: 'ai-ok-code' }, { name: 'ai-ok-sec' }, { name: 'bug' }],
		},
		{ number: 2, title: 'b', labels: [{ name: 'bug' }] },
	])
	expect(items).toEqual([
		{ kind: 'pr', number: 1, title: 'a', labels: ['ai-ok-code', 'ai-ok-sec'] },
	])
	expect(items.map(isMergeReady)).toEqual([true])
})

test('describes a subagent tool call in one short line', () => {
	expect(describeCall('Bash', { command: 'pnpm   test' })).toBe('Bash pnpm test')
	expect(describeCall('Edit', { file_path: '/a/b/src/x.ts' })).toBe('Edit x.ts')
	expect(describeCall('Grep', { pattern: 'x'.repeat(40) })).toBe(`Grep ${'x'.repeat(31)}…`)
	expect(describeCall('TodoWrite', { todos: [] })).toBe('TodoWrite')
	expect(agentIcon('Explore')).toBe('🔍')
	expect(agentIcon('anything')).toBe('🤖')
})
