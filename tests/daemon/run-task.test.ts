import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixPrompt, implementPrompt, reviewPrompt } from '../../src/daemon/prompts.js'
import { describeEvent, runTask, trailer } from '../../src/daemon/run-task.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

/** A stand-in for `claude -p`: prints the given stream-json lines, then exits. */
function fakeClaude(dir: string, lines: unknown[], exit = 0): [string, string] {
	const file = join(dir, 'fake-claude.mjs')
	writeFileSync(
		file,
		`for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l)
console.log(JSON.stringify({ cwd: process.cwd(), token: process.env.GH_TOKEN }))
process.exit(${exit})`
	)
	return [process.execPath, file]
}

describe('runTask', () => {
	it('streams tool steps as progress and returns the result line', async () => {
		const dir = newTmpDir()
		const progress: string[] = []
		const r = await runTask({
			prompt: 'x',
			cwd: dir,
			env: { GH_TOKEN: 'ghs_t' },
			timeoutMs: 10_000,
			onProgress: (l) => progress.push(l),
			command: fakeClaude(dir, [
				{ type: 'system', subtype: 'init' },
				{
					type: 'assistant',
					message: {
						content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr view 3\nmore' } }],
					},
				},
				{
					type: 'result',
					is_error: false,
					result: 'done\nPR: #12',
					total_cost_usd: 0.25,
					usage: { output_tokens: 900 },
				},
			]),
		})
		expect(progress).toEqual(['Bash gh pr view 3'])
		expect(r).toMatchObject({ ok: true, result: 'done\nPR: #12', costUsd: 0.25, outputTokens: 900 })
		expect(trailer(r.result, 'PR')).toBe('#12')
	})

	it('reports a crash without a result line', async () => {
		const dir = newTmpDir()
		const r = await runTask({
			prompt: 'x',
			cwd: dir,
			timeoutMs: 10_000,
			command: fakeClaude(dir, [], 3),
		})
		expect(r.ok).toBe(false)
		expect(r.error).toMatch(/^exited 3/)
	})

	it('reports a missing executable', async () => {
		const r = await runTask({
			prompt: 'x',
			cwd: newTmpDir(),
			timeoutMs: 10_000,
			command: ['/nope/claude'],
		})
		expect(r.error).toMatch(/could not start/)
	})

	it('kills a task past its timeout', async () => {
		const dir = newTmpDir()
		const file = join(dir, 'hang.mjs')
		writeFileSync(file, 'setTimeout(() => {}, 60_000)')
		const r = await runTask({
			prompt: 'x',
			cwd: dir,
			timeoutMs: 200,
			command: [process.execPath, file],
		})
		expect(r.error).toMatch(/timed out/)
	})
})

describe('describeEvent', () => {
	it('skips everything but assistant tool calls', () => {
		expect(describeEvent({ type: 'user' })).toBeNull()
		expect(
			describeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
		).toBeNull()
		expect(
			describeEvent({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }] },
			})
		).toBe('Read /a')
	})
})

describe('prompts', () => {
	it('keep the rules a run depends on', () => {
		const impl = implementPrompt({ repo: 'o/r', issue: 5, title: 't', slug: 'ai-5-t' })
		expect(impl).toContain('UNTRUSTED DATA')
		expect(impl).toContain('Closes #5')
		expect(impl).toContain('NEVER merge')

		const both = reviewPrompt({ repo: 'o/r', pr: 9, issue: 5, arm: 'both' })
		expect(both).toContain('<!-- ai-issue-loop:verdict:code:')
		expect(both).toContain('<!-- ai-issue-loop:verdict:sec:')
		expect(both).toContain(
			'--add-label ai-ok-code --add-label ai-ok-sec --remove-label ai-reviewing-code --remove-label ai-reviewing-sec'
		)
		expect(both).not.toContain('--approve`')

		expect(fixPrompt({ repo: 'o/r', pr: 9, defaultBranch: 'main', conflicts: true })).toContain(
			'Never rebase or force-push'
		)
	})
})
