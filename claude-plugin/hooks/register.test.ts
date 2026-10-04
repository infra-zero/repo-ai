import { expect, mock, test } from 'claude-code/testing'

// A `repo-ai loop dash --json` result, as #274 prints it (no bodies).
const FIXTURE = {
	summary: '1 pickup, 1 review',
	halt: null,
	liveAgents: 1,
	slots: 5,
	pickups: [{ number: 12, title: 'x', stackedOn: null }],
	skippedPickups: [],
	reviewsToSpawn: [{ pr: 40, arm: 'code' }],
	fixRounds: [],
	handoffs: [{ pr: 41, autoMerge: false, notes: true }],
	sendBacks: [],
	stalled: [],
	toClean: [],
	updateBranches: [],
	dependabotRecreate: [],
	dependabotStalled: [],
	releaseGated: true,
	warnings: ['slow gh'],
	errors: [],
	staleInstall: [],
}

const RUN = {
	command: 'ai-loop-dash',
	args: '',
	origin: { kind: 'composer' },
	presentation: { isFullscreen: false, columns: 120 },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
	test(`draws the loop dash sections on ${surface}`, async ($, on) => {
		const clock = mock.clock(on)
		const argvs: string[][] = []
		on('process.run', async (_$, e) => {
			argvs.push([...e.argv])
			return {
				value: {
					exitCode: 0,
					stdout: JSON.stringify(FIXTURE),
					stderr: '',
					isStdoutTruncated: false,
					isStderrTruncated: false,
				},
			}
		})
		on('fs.read', async () => ({ value: JSON.stringify({ pollSeconds: 90 }) }))
		on('ui.open', async () => ({ value: { isPlaced: true as const } }))

		await $.command.run(RUN)
		await clock.settle()
		expect(argvs).toEqual([['npx', '--no', 'repo-ai', 'loop', 'dash', '--json']])

		const ui = await $.ui.mount({
			plugin: 'repo-ai',
			surface,
			component: 'Pane',
			requestId: 'ai-loop',
			props: {
				title: 'ai-loop',
				isFocused: false,
				bodyColumns: 80,
				placement: 'dock',
				scroll: { offset: 0, bodyRows: 30 },
				view: {},
			},
		})
		const text = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
		expect(text).toContain('1 pickup, 1 review  agents 1/6')
		expect(text).toContain('pickups (1)')
		expect(text).toContain('  #12')
		expect(text).toContain('reviews to spawn (1)')
		expect(text).toContain('  #40  code')
		expect(text).toContain('handoffs (1)')
		expect(text).toContain('  #41  notes')
		expect(text).toContain('release-gated')
		expect(text).toContain('warn: slow gh')
		expect(text).not.toContain('fix rounds (0)')

		// polls again at the repo's pollSeconds
		await clock.advance(90_000)
		expect(argvs.length).toBe(2)
	})
}
