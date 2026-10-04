#!/usr/bin/env node

import { Command } from 'commander'
import { mainCheckout } from '../base/git.js'
import { doctorCommand } from './commands/doctor.js'
import { appTokenCommand } from './commands/auth.js'
import { dashboardCommand } from './commands/dashboard.js'
import { FIXERS, fixCommand } from './commands/fix.js'
import { loopApplyCommand } from './commands/loop-apply.js'
import { loopCleanupCommand } from './commands/loop-cleanup.js'
import { loopEnvCommand } from './commands/loop-env.js'
import { loopGuardCommand } from './commands/loop-guard.js'
import { loopCommentCommand, loopVerdictCommand } from './commands/loop-marker.js'
import { loopReapCommand } from './commands/loop-reap.js'
import { loopTickCommand, loopTierCommand } from './commands/loop-tick.js'
import { loopDashCommand } from './commands/loop-dash.js'
import { loopWatchCommand } from './commands/loop-watch.js'
import { loopWorktreeAddCommand } from './commands/loop-worktree.js'
import { setupCommand } from './commands/setup.js'
import { getToolVersion } from './utils/version.js'

const program = new Command()

// The main checkout containing cwd, so `--root` is never required — even from a worktree (#150).
const ROOT = mainCheckout()

program
	.name('repo-ai')
	.description('🤖 The ai-loop pipeline: loop mechanics, skills, and their audit')
	.version(await getToolVersion())

program
	.command('setup')
	.description(
		'🚀 Onboard a repo: claude-skills, labels, ai-loop-identity, statusline, claude-plugin — asking before each — then doctor'
	)
	.option('-d, --dir <path>', 'Repository to set up', process.cwd())
	.option('-y, --yes', 'Run every step without prompting')
	.option('--skills-dir <path>', 'claude-skills: install here instead of ~/.claude/skills')
	.option('--force-skills', 'claude-skills: overwrite a locally modified or newer copy')
	.option('--gh-config-dir <path>', 'ai-loop-identity: the agent gh profile directory')
	.option('--json', 'Emit machine-readable JSON output (implies --yes)')
	.action(setupCommand)

program
	.command('doctor')
	.description(
		'🩺 Audit the loop setup: labels, agent user, installed and required skills, statusline'
	)
	.option('-d, --dir <path>', 'Repository to audit', process.cwd())
	.option('--skills-dir <path>', 'Skills directory to check (default: ~/.claude/skills)')
	.option('--json', 'Emit machine-readable JSON output')
	.action(doctorCommand)

program
	.command('fix <target>')
	.description(`🔧 Apply one fixer: ${Object.keys(FIXERS).join(', ')}`)
	.option('-d, --dir <path>', 'Repository to fix', process.cwd())
	.option('-y, --yes', 'Never prompt')
	.option('--skills-dir <path>', 'claude-skills: install here instead of ~/.claude/skills')
	.option('--force-skills', 'claude-skills: overwrite a locally modified or newer copy')
	.option('--gh-config-dir <path>', 'ai-loop-identity: the agent gh profile directory')
	.option('--json', 'Emit machine-readable JSON output (implies --yes)')
	.action(fixCommand)

program
	.command('auth')
	.description('🔑 Credentials for running the loop as a GitHub App')
	.command('app-token')
	.description('Print an installation token for the App on one repo (GITHUB_APP_ID + private key)')
	.requiredOption('--repo <owner/repo>', 'The repo to scope the token to')
	.option('--json', 'Print {token, expiresAt, login}')
	.action(appTokenCommand)

program
	.command('dashboard')
	.description('🖥️  The Docker dashboard: setup, the scheduler, the worker queue and the view')
	.option('--port <n>', 'Port', (v) => Number(v), 8080)
	.option('--host <addr>', 'Address to bind (compose maps it to 127.0.0.1 on the host)', '0.0.0.0')
	.option('--data <dir>', 'Config, events', '/data')
	.option('--repos <dir>', 'Clones and worktrees', '/repos')
	.action(async (o) => void (await dashboardCommand(o)))

const loop = program.command('loop').description('🔁 ai-loop mechanics as tested commands')

loop
	.command('guard')
	.description('🛡️  Repair a wrongly-bare main checkout and gate the node_modules rebuild')
	.option('--root <path>', 'Main checkout the loop branches worktrees from', ROOT)
	.option('--worktree-root <path>', 'Where ai-* worktrees live (default: <root>-worktrees)')
	.option('--removed', 'A worktree was removed this tick — consider rebuilding node_modules')
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		'\nExit codes:\n' +
			'  0  root is a usable work tree (healthy, or repaired in place) — continue the tick\n' +
			'  1  repair was attempted and failed; the root is still bare — halt the tick\n' +
			'  2  root is not a repairable main checkout (bare clone, linked worktree, or not a repo) — halt the tick\n'
	)
	.action(loopGuardCommand)

loop
	.command('env')
	.description('🧭 Resolve ROOT, WT_ROOT, OWNER_REPO, AGENT_USER, HUMAN_USER and ME once')
	.option(
		'-d, --dir <path>',
		'Directory to resolve from — main checkout or any worktree',
		process.cwd()
	)
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		"\nWithout --json, prints KEY='value' lines for eval. Empty means none.\n" +
			'Exits 1 when the checkout or its GitHub repo cannot be resolved.\n'
	)
	.action(loopEnvCommand)

loop
	.command('apply')
	.description("✍️  Apply a tick's transitions (Pass 1 and 2) and take its claims (Pass 3 and 4)")
	.option('--root <path>', 'Main checkout the loop branches worktrees from', process.cwd())
	.option('--worktree-root <path>', 'Where ai-* worktrees live (default: <root>-worktrees)')
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		'\nReads the same state as `loop tick`, then applies it. Comments stay with the caller:\n' +
			'`comments` lists each one owed. A failed edit lands in `errors`; the next apply retries it.\n' +
			'`claimed` lists the review, fix and pickup tasks it claimed, for the caller to launch.\n' +
			"Exit 1 or 2 halts the tick (loop tick's or loop guard's codes).\n"
	)
	.action(loopApplyCommand)

loop
	.command('cleanup')
	.description('🧹 Remove ai-* worktrees whose PR landed on main or was closed')
	.option('--root <path>', 'Main checkout the loop branches worktrees from', ROOT)
	.option('--worktree-root <path>', 'Where ai-* worktrees live (default: <root>-worktrees)')
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		'\nPass `removed` from --json to `loop guard --removed`.\n' +
			'Exits 1 when a worktree removal failed.\n'
	)
	.action(loopCleanupCommand)

loop
	.command('worktree')
	.description('🌳 Loop worktree mechanics')
	.command('add <slug>')
	.description(
		"🌱 Create ai-<issue>-<slug> off the repo's default branch, link its deps, assert none are missing"
	)
	.option('--root <path>', 'Main checkout to branch the worktree from', ROOT)
	.option('--worktree-root <path>', 'Where ai-* worktrees live (default: <root>-worktrees)')
	.option('--base <ref>', "Ref to branch from (default: origin/<the repo's default branch>)")
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		'\nExit 1 when the worktree was not created or a symlinkDirectories entry is left\n' +
			'unlinked — do not spawn an implementer. needsInstall means no list was declared.\n'
	)
	.action(loopWorktreeAddCommand)

loop
	.command('reap')
	.description('🪦 Report agents stalled past 45 minutes and what to do about each')
	.option('--root <path>', 'Main checkout the loop branches worktrees from', ROOT)
	.option('--worktree-root <path>', 'Where ai-* worktrees live (default: <root>-worktrees)')
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		'\nRead-only: prints a verdict per stall (block / drop-label / remove-worktree).\n' +
			'Exits 1 when a gh query failed and the report is incomplete.\n'
	)
	.action(loopReapCommand)

loop
	.command('comment <pr>')
	.description("💬 Upsert the loop's one decision-marker comment on a PR")
	.requiredOption('--body-file <path>', 'Comment text, without the marker (- for stdin)')
	.option('-d, --dir <path>', 'Directory to resolve the GitHub repo from', process.cwd())
	.option('--json', 'Emit machine-readable JSON output')
	.action(loopCommentCommand)

loop
	.command('verdict <pr>')
	.description("⚖️  Read a reviewer arm's verdict marker for the PR's current head")
	.requiredOption('--arm <arm>', 'Reviewer arm: code or sec')
	.option('-d, --dir <path>', 'Directory to resolve the GitHub repo from', process.cwd())
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		'\nPrints PASS, PASS-NOTES, CHANGES, or an empty line when none is posted.\n' +
			'Exits 1 when the PR or its reviews cannot be read.\n'
	)
	.action(loopVerdictCommand)

loop
	.command('tier <pr>')
	.description('🪜 Choose the review tier from the PR diff: both (docs-only) or split')
	.option('-d, --dir <path>', 'Directory to resolve the GitHub repo from', process.cwd())
	.option('--json', 'Emit machine-readable JSON output')
	.action(loopTierCommand)

loop
	.command('tick')
	.description("📋 Compute one tick's work list — guard, cleanup, reap, verdicts, pickups")
	.option('--root <path>', 'Main checkout, or any worktree of it', process.cwd())
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		'\nWrites no GitHub state and removes no worktree: `loop apply` makes the Pass 1 and\n' +
			'Pass 2 edits; the caller comments and spawns.\n' +
			"Exit 1 or 2 halts the tick (loop guard's codes, or an unresolvable checkout).\n"
	)
	.action(loopTickCommand)

loop
	.command('watch')
	.description("👀 Poll the tick's work list; print a line only when it changes")
	.option('--root <path>', 'Main checkout, or any worktree of it', process.cwd())
	.option('--json', 'Emit machine-readable JSON output')
	.addHelpText(
		'after',
		'\nPolls every `pollSeconds` from .repo-ai.json (default 180, floor 60) until killed.\n' +
			'Prints one line when the actionable work list changes, and a halt once until it\n' +
			'clears. Failed polls go to stderr and are skipped. Like `loop tick`, it removes\n' +
			'nothing: worktrees whose PR landed or closed come back in `toClean`.\n'
	)
	.action(loopWatchCommand)

loop
	.command('dash')
	.description("📊 Live terminal view of the tick's work list (read-only)")
	.option('--root <path>', 'Main checkout, or any worktree of it', process.cwd())
	.option('--once', 'Render one frame and exit (implied when stdout is not a TTY)')
	.option('--json', 'Print the tick result once, issue bodies removed')
	.addHelpText(
		'after',
		'\nPolls every `pollSeconds` from .repo-ai.json and redraws until killed. Prints numbers,\n' +
			'labels and reasons only, never an issue or PR body. Writes nothing to GitHub and\n' +
			'leaves the status file alone.\n'
	)
	.action(loopDashCommand)

await program.parseAsync()
