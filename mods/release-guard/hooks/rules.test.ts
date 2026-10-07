import { expect, test } from 'claude-code/testing'

import { blockedBash, blockedEdit } from './rules'

test('blocks release commands', () => {
	for (const cmd of [
		'npm publish',
		'pnpm --filter x publish --access public',
		'pnpm version minor',
		'npx semantic-release',
		'git tag v1.2.3',
		'git push --force origin main',
		'git push -f',
		'git push origin +main',
		'git push --tags',
		'git push --force-with-lease',
		'gh workflow run release.yml',
		'gh release create v1',
		'cd x && pnpm publish',
		'echo ok; git push origin :v1',
		'pnpm build && npx semantic-release',
		'git status\ngit tag v2',
		'CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm publish',
		'git -C ../wt tag v1.0.0',
		'git -C ../wt push --force',
		'gh workflow run -R infra-zero/repo-ai release.yml',
		'pnpm dlx semantic-release --dry-run',
		'bun pm version patch',
		'gh workflow run --ref main release.yml',
		'gh workflow run Release',
		'if test -n "$X"; then pnpm publish; fi',
		'if true\nthen\n  npm publish\nfi',
		'for p in a b; do git tag "$p"; done',
		'env CI=1 pnpm publish',
		'git push --follow-tags',
		'gh workflow run -R o/r --ref=main -f a=b release.yml',
		'gh workflow run --repo=infra-zero/repo-ai release.yml',
	])
		expect(blockedBash(cmd)).toBeDefined()
})

test('allows everyday commands', () => {
	for (const cmd of [
		'git push',
		'git push -u origin feat/x',
		'git tag',
		'git tag -l',
		'git tag --list "v*"',
		'pnpm test',
		'gh pr create --fill',
		'gh workflow run ci.yml',
		'git log --format=%f',
		'git -C ../wt push -u origin feat/x',
		'CI=1 pnpm test',
		'gh workflow run ci.yml --ref feat/327-release-guard',
		'git tag --sort=-v:refname | head -3',
		'git tag --merged main',
		'git tag | sort',
		`gh workflow run ${Array.from({ length: 40 }, (_, i) => `--f${i}=v`).join(' ')} ci.yml`,
		'pnpm run publish-docs',
		'gh issue create --title "then npm publish breaks"',
		"cat > notes.md <<'X'\n- Bash: npm|pnpm … publish, git tag <name>, git push --force\nX",
		'gh issue create --title "blocks npm publish and git push --force"',
	])
		expect(blockedBash(cmd)).toBeUndefined()
})

test('blocks package.json version edits only', () => {
	expect(blockedEdit('package.json', '"version": "1.0.0"', '"version": "1.1.0"')).toBeDefined()
	expect(blockedEdit('a/package.json', '"lint": "x"', '"lint": "y"')).toBeUndefined()
	expect(blockedEdit('src/version.ts', '"version": "1"', '"version": "2"')).toBeUndefined()
})
