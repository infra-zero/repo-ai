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
})
