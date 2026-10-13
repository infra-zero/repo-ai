import { defineConfig, mergeConfig } from 'vitest/config'
import base from '@rtorcato/repo-tooling/vitest/config'
import { stripAmbientGitEnv } from './scripts/lib/git-env.mjs'

// Before any test spawns git in a temp directory — under a hook, GIT_DIR would
// redirect it into this repo. See the helper for the full failure mode.
stripAmbientGitEnv()

// release-guard's rules are pure, so `pnpm verify` runs their test too (#355); its
// `claude-code/testing` import is the same test/expect API vitest provides. The
// mod's own tsconfig extends a gitignored file Claude Code generates, so the
// transform is pinned to the root one. CI's "Test the mods" step still runs every
// mod under Claude Code's own runner.
export default mergeConfig(
	base,
	defineConfig({
		tsconfig: 'tsconfig.build.json',
		resolve: { alias: { 'claude-code/testing': 'vitest' } },
		test: { include: ['tests/**/*.test.ts', 'mods/release-guard/hooks/rules.test.ts'] },
	})
)
