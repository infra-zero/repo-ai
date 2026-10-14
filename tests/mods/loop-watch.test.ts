import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf-8')

describe('mods/loop-watch (#326)', () => {
	it('treats the status file as stale at the same age as statusline/ai-loop.sh', () => {
		const shell = read('statusline/ai-loop.sh').match(/^STALE_AFTER=(\d+)$/m)?.[1]
		const mod = read('mods/loop-watch/hooks/parse.ts').match(/^const STALE_AFTER = (\d+)$/m)?.[1]
		expect(shell).toBeDefined()
		expect(mod).toBe(shell)
	})

	it("keeps the rainbow plugin's clean() identical to its own (#337)", () => {
		const fn = (path: string) => read(path).match(/^export function clean[\s\S]*?^}$/m)?.[0]
		expect(fn('mods/loop-watch/hooks/parse.ts')).toBeDefined()
		expect(fn('mods/repo-ai-rainbow/hooks/register.tsx')).toBe(fn('mods/loop-watch/hooks/parse.ts'))
	})

	it('pins the executable plugins to a full commit sha (#337)', () => {
		const { plugins } = JSON.parse(read('.claude-plugin/marketplace.json'))
		for (const name of ['loop-watch', 'repo-ai-rainbow']) {
			const { source } = plugins.find((p: { name: string }) => p.name === name)
			expect(source.source).toBe('git-subdir')
			expect(source.sha).toMatch(/^[0-9a-f]{40}$/)
		}
	})

	it('points the pinned plugins at mods/, where #384 moved them (#385)', () => {
		const { plugins } = JSON.parse(read('.claude-plugin/marketplace.json'))
		for (const name of ['loop-watch', 'repo-ai-rainbow']) {
			const { source } = plugins.find((p: { name: string }) => p.name === name)
			expect(source.path).toBe(`mods/${name}`)
		}
	})
})
