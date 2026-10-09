import { expect, test } from 'claude-code/testing'

const GH = {
	issue: [
		{ labels: [{ name: 'ai-ready' }] },
		{ labels: [{ name: 'ai-ready' }, { name: 'bug' }] },
		{ labels: [{ name: 'ai-blocked' }] },
	],
	pr: [{ labels: [{ name: 'ai-review' }, { name: 'ai-ok-code' }] }],
}

test('/repo-ai counts labels across issues and PRs', async ($, on) => {
	on('process.run', async (_$, e) => {
		const kind = e.argv[1] as 'issue' | 'pr'
		return {
			value: {
				exitCode: 0,
				stdout: JSON.stringify(GH[kind]),
				stderr: '',
				isStdoutTruncated: false,
				isStderrTruncated: false,
			},
		}
	})
	on('fs.read', async () => ({ value: 'idle·cron\n\n\n1000\n' }))
	on('clock.now', async () => ({ value: 1_120_000 }))

	const { text } = await $.command.run({ command: 'repo-ai' })

	expect(text).toContain('ai-ready 2')
	expect(text).toContain('ai-blocked 1')
	expect(text).toContain('ai-review 1')
	expect(text).toContain('ai-ok-code 1')
	expect(text).toContain('ai-wip 0')
	expect(text).toContain('loop idle·cron (for 2m)')
})

test('/repo-ai hides a loop whose next tick is long overdue', async ($, on) => {
	on('process.run', async () => ({
		value: {
			exitCode: 0,
			stdout: '[]',
			stderr: '',
			isStdoutTruncated: false,
			isStderrTruncated: false,
		},
	}))
	// Next tick was due at 1000s; now is 1000s + 5 min slack + 1s.
	on('fs.read', async () => ({ value: 'working·#12\n\n1000\n900\n' }))
	on('clock.now', async () => ({ value: 1_301_000 }))

	const { text } = await $.command.run({ command: 'repo-ai' })

	expect(text).toContain('ai-ready 0')
	expect(text).not.toContain('working')
})

test('/repo-ai degrades when gh fails', async ($, on) => {
	on('process.run', async () => ({
		value: {
			exitCode: 1,
			stdout: '',
			stderr: 'not a git repo',
			isStdoutTruncated: false,
			isStderrTruncated: false,
		},
	}))

	const { text } = await $.command.run({ command: 'repo-ai' })

	expect(text).toContain('no GitHub data')
})
