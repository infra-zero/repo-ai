import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf-8')

// #364: the README claimed 2.1.292+, CI tested the mods on 2.1.285 and Docker
// pinned 2.1.289. One minimum, stated everywhere a version is.
const FILES = [
	'README.md',
	'apps/docs/docs/intro.md',
	'.github/workflows/ci.yml',
	'docker/Dockerfile',
	'.claude-plugin/marketplace.json',
	...readdirSync(new URL('../mods', import.meta.url)).map(
		(m) => `mods/${m}/.claude-plugin/plugin.json`
	),
]

describe('Claude Code version (#364)', () => {
	it('is the same minimum in the docs, CI, the Dockerfile and the plugin manifests', () => {
		const found = FILES.flatMap((file) =>
			[
				...read(file).matchAll(
					/(?:claude-code@|CLAUDE_CODE_VERSION=|Claude Code )(\d+\.\d+\.\d+)/g
				),
			].map((m) => `${m[1]} (${file})`)
		)
		expect(found.length).toBeGreaterThan(0)
		const versions = new Set(found.map((f) => f.split(' ')[0]))
		expect(versions.size, found.join('\n')).toBe(1)
	})
})
