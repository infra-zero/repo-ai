import { afterEach, describe, expect, it, vi } from 'vitest'

const setupCommand = vi.fn(async () => {})
vi.mock('../../src/cli/commands/setup.js', () => ({ setupCommand }))

describe('repo-ai CLI', () => {
	const argv = process.argv
	afterEach(() => {
		process.argv = argv
		vi.restoreAllMocks()
	})

	// A patch release must not turn an old `setup --gh-config-dir` into an
	// unknown-option error (#365): the flag is accepted, hidden and ignored.
	it('still accepts setup --gh-config-dir and passes it through', async () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		process.argv = ['node', 'repo-ai', 'setup', '--gh-config-dir', 'x', '--yes']
		await import('../../src/cli/index.js')
		expect(exit).not.toHaveBeenCalled()
		expect(stderr.mock.calls.flat().join('')).not.toContain('unknown option')
		expect(setupCommand).toHaveBeenCalledWith(
			expect.objectContaining({ ghConfigDir: 'x', yes: true }),
			expect.anything()
		)
	})
})
