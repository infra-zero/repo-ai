import Link from '@docusaurus/Link'
import Siblings from '@rtorcato/shared-docs/components/Siblings'
import CodeBlock from '@theme/CodeBlock'
import Layout from '@theme/Layout'
import TabItem from '@theme/TabItem'
import Tabs from '@theme/Tabs'
import clsx from 'clsx'
import type { ReactElement } from 'react'
import styles from './index.module.css'

// Layout and styles follow repo-tooling's landing page (apps/docs/src/pages there);
// only the content is repo-ai's.

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

type IconKey = 'tag' | 'branch' | 'eyes' | 'hand'

function Icon({ icon, title }: { icon: IconKey; title: string }): ReactElement {
	return (
		<svg
			className={styles.pillarIconSvg}
			width={20}
			height={20}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.6}
			strokeLinecap="round"
			strokeLinejoin="round"
			role="img"
		>
			<title>{title}</title>
			{ICONS[icon]}
		</svg>
	)
}

const ICONS: Record<IconKey, ReactElement> = {
	tag: (
		<>
			<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
			<circle cx="7.5" cy="7.5" r="1.5" />
		</>
	),
	branch: (
		<>
			<circle cx="6" cy="5" r="2" />
			<circle cx="6" cy="19" r="2" />
			<circle cx="18" cy="8" r="2" />
			<path d="M6 7v10" />
			<path d="M18 10c0 4-6 3-12 7" />
		</>
	),
	eyes: (
		<>
			<circle cx="8" cy="12" r="4" />
			<circle cx="16" cy="12" r="4" />
			<circle cx="8" cy="12" r="1" />
			<circle cx="16" cy="12" r="1" />
		</>
	),
	hand: (
		<>
			<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6" />
			<path d="M11 11V4a1.5 1.5 0 0 1 3 0v7" />
			<path d="M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15.5a1.5 1.5 0 0 1 2.4-1.8L8 16" />
		</>
	),
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const PILLARS: { title: string; desc: string; icon: IconKey }[] = [
	{
		title: 'Label-driven',
		desc: 'All state lives in GitHub labels, never in a conversation — a missed tick, a crash, or a restart costs nothing.',
		icon: 'tag',
	},
	{
		title: 'One worktree per issue',
		desc: 'Each ai-ready issue gets its own git worktree and branch, so agents run in parallel without touching your checkout.',
		icon: 'branch',
	},
	{
		title: 'Two agent reviewers',
		desc: 'A code reviewer and a security reviewer read every diff. Changes requested get up to two fix rounds, then a human.',
		icon: 'eyes',
	},
	{
		title: 'You merge',
		desc: 'The loop never merges an issue PR. It labels it merge-ready, assigns it to you, and says why on the PR when it holds back.',
		icon: 'hand',
	},
]

const EXAMPLES: { label: string; file: string; code: string }[] = [
	{
		label: 'install',
		file: 'Skills, labels, agent identity and statusline — asking before each',
		code: `npx @rtorcato/repo-ai setup`,
	},
	{
		label: 'run',
		file: 'In Claude Code',
		code: `/ai-issue "Add --json to the reap command"   # file an ai-ready issue
/ai-loop                                    # work the queue, then keep babysitting the PRs
/ai-loop-status                             # read-only: what is the loop doing?
/ai-loop-stop                               # stop this repo's loop`,
	},
	{
		label: 'audit',
		file: 'Check labels, agent user, and installed skills',
		code: `npx @rtorcato/repo-ai doctor
npx @rtorcato/repo-ai loop tick --json   # one tick's work list; writes no GitHub state`,
	},
]

const GUIDE = '/docs/ai-loop'

const PARTS: { name: string; desc: string; chips: string[]; href: string }[] = [
	{
		name: 'Label state machine',
		desc: 'ai-ready → ai-wip → ai-review → merge-ready. Every transition is a label, and colours carry meaning.',
		chips: ['ai-ready', 'ai-review', 'ai-changes', 'merge-ready'],
		href: `${GUIDE}#labels-and-the-state-machine`,
	},
	{
		name: 'The tick',
		desc: 'One stateless pass: guard the checkout, clean up landed worktrees, reap stalled agents, read verdicts, pick up issues.',
		chips: ['loop tick', 'loop guard', 'loop reap'],
		href: `${GUIDE}#the-tick`,
	},
	{
		name: 'Claude Code skills',
		desc: 'The loop, the issue on-ramp, and a read-only status view — installed into ~/.claude/skills.',
		chips: ['ai-loop', 'ai-issue', 'ai-loop-status', 'ai-loop-stop'],
		href: '/docs/commands',
	},
	{
		name: 'Repo prerequisites',
		desc: 'Squash + auto-merge + delete-on-merge, a required status check, and no required reviews — or every PR deadlocks.',
		chips: ['branch protection', 'auto-merge'],
		href: `${GUIDE}#repo-prerequisites`,
	},
	{
		name: 'Limits',
		desc: 'Six issues in flight, diff-only reviewers, two fix rounds per PR, and an idle tick spawns zero agents.',
		chips: ['budget', 'fix rounds'],
		href: `${GUIDE}#limits`,
	},
	{
		name: 'Safety',
		desc: 'Public repos: only ai-ready issues from owners, members, or collaborators run, and the issue body is data, never instructions.',
		chips: ['ai-ready gate', 'author association'],
		href: `${GUIDE}#safety`,
	},
]

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

function Hero(): ReactElement {
	return (
		<header className={styles.hero}>
			<div className={styles.heroGlow} aria-hidden />
			<div className={styles.heroInner}>
				<div className={styles.wordmark}>
					<span className={styles.wmRepo}>repo</span>
					<span className={styles.wmDash}>-</span>
					<span className={styles.wmAi}>ai</span>
				</div>
				<p className={styles.tagline}>
					Turns <code>ai-ready</code> GitHub issues into reviewed PRs — one worktree per issue, two
					agent reviewers, and a human who merges.
				</p>

				<div className={styles.heroBody}>
					<div className={styles.codeWindow}>
						<Tabs className={styles.codeTabs} groupId="hero-command">
							{EXAMPLES.map((ex) => (
								<TabItem key={ex.label} value={ex.label} label={ex.label}>
									<div className={styles.codeFile}>{ex.file}</div>
									<CodeBlock language="bash" className={styles.codePre}>
										{ex.code}
									</CodeBlock>
								</TabItem>
							))}
						</Tabs>
					</div>
				</div>

				<div className={styles.heroActions}>
					<div className={styles.heroButtons}>
						<Link className={clsx('button button--primary button--lg', styles.cta)} to={GUIDE}>
							How the loop works →
						</Link>
						<Link className={clsx('button button--lg', styles.ctaSecondary)} to="/docs/commands">
							Commands
						</Link>
					</div>
				</div>
			</div>
		</header>
	)
}

function Pillars(): ReactElement {
	return (
		<section className={styles.section}>
			<div className={styles.pillarGrid}>
				{PILLARS.map((p) => (
					<div key={p.title} className={styles.pillar}>
						<div className={styles.pillarIcon}>
							<Icon icon={p.icon} title={p.title} />
						</div>
						<div className={styles.pillarTitle}>{p.title}</div>
						<div className={styles.pillarDesc}>{p.desc}</div>
					</div>
				))}
			</div>
		</section>
	)
}

function Parts(): ReactElement {
	return (
		<section className={styles.section}>
			<div className={styles.sectionHead}>
				<div>
					<h2 className={styles.h2}>How it fits together</h2>
					<p className={styles.sub}>
						A label state machine, a stateless tick, and the skills that drive it. Start with the
						guide; <code>doctor</code> tells you what your repo is missing.
					</p>
				</div>
				<Link className={styles.viewAll} to={GUIDE}>
					Read the guide →
				</Link>
			</div>
			<div className={styles.catGrid}>
				{PARTS.map((c) => (
					<Link key={c.name} to={c.href} className={styles.card}>
						<div className={styles.cardHead}>
							<div className={styles.cardName}>{c.name}</div>
						</div>
						<p className={styles.cardDesc}>{c.desc}</p>
						<div className={styles.chips}>
							{c.chips.map((ch) => (
								<span key={ch} className={styles.chip}>
									{ch}
								</span>
							))}
						</div>
					</Link>
				))}
			</div>
		</section>
	)
}

export default function Home(): ReactElement {
	return (
		<Layout
			title="repo-ai"
			description="Turns ai-ready GitHub issues into reviewed PRs — one worktree per issue, two agent reviewers."
		>
			<main>
				<Hero />
				<Pillars />
				<Parts />
				<Siblings self="@rtorcato/repo-ai" />
			</main>
		</Layout>
	)
}
