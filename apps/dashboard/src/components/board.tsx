import { Link } from '@tanstack/react-router'
import { Check, Circle, CircleDashed, GitPullRequest, Plus, Shield, X } from 'lucide-react'
import type { BoardItem } from '@repo-ai/daemon/board'
import type { Stage } from '@repo-ai/base/stage'
import type { DashboardView } from '~/lib/api'
import { cn } from '~/lib/utils'
import { Badge, type BadgeVariant } from './ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { ageOf, ago, SafeLink, short } from './common'
import { GettingStarted, progress } from './getting-started'

type Repo = DashboardView['repos'][number]

// Same order as STAGES in src/base/stage.ts, copied so no runtime code is imported from src/.
const STAGES = [
	'blocked',
	'merge-ready',
	'changes',
	'conflicts',
	'fixing',
	'review',
	'wip',
	'ready',
	'holding',
] as const satisfies readonly Stage[]
const PIPELINE: Stage[] = ['ready', 'wip', 'review', 'fixing', 'merge-ready']
const STAGE_TONE: Record<Stage, BadgeVariant> = {
	blocked: 'danger',
	'merge-ready': 'success',
	changes: 'warning',
	conflicts: 'warning',
	fixing: 'info',
	review: 'info',
	wip: 'info',
	ready: 'muted',
	holding: 'muted',
}

function Pipeline({ stage }: { stage: Stage }) {
	const at = PIPELINE.indexOf(stage)
	if (at < 0) return <Badge variant={STAGE_TONE[stage]}>{stage}</Badge>
	return (
		<div className="flex items-center gap-1" title={stage}>
			{PIPELINE.map((s, i) => (
				<span
					key={s}
					className={cn(
						'h-1.5 w-5 rounded-full',
						i < at && 'bg-primary/40',
						i === at && 'bg-primary ring-2 ring-primary/30',
						i > at && 'bg-muted'
					)}
				/>
			))}
			<span className="ml-1 text-xs font-medium text-primary">{stage}</span>
		</div>
	)
}

const REVIEW_ICON = {
	pass: { Icon: Check, tone: 'text-emerald-500', label: 'pass' },
	running: { Icon: CircleDashed, tone: 'text-sky-500 animate-spin', label: 'running' },
	changes: { Icon: X, tone: 'text-red-500', label: 'changes requested' },
	pending: { Icon: Circle, tone: 'text-muted-foreground', label: 'pending' },
} as const

function Arm({ name, state }: { name: string; state: keyof typeof REVIEW_ICON }) {
	const { Icon, tone, label } = REVIEW_ICON[state]
	return (
		<span className="inline-flex items-center gap-1 text-xs" title={`${name} review: ${label}`}>
			<Icon className={cn('size-3.5', tone)} />
			{name}
		</span>
	)
}

const CI_TONE = { green: 'success', red: 'danger', pending: 'warning', none: 'muted' } as const

function Item({ item }: { item: BoardItem }) {
	return (
		<div className="flex flex-col gap-1.5 rounded-md border bg-background/50 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 text-sm">
					<SafeLink href={item.url}>#{item.number}</SafeLink>{' '}
					<span className="break-words">{item.title}</span>
				</div>
				<span className="shrink-0 text-xs text-muted-foreground">
					{item.kind} · {ageOf(item.ageMinutes)}
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<Pipeline stage={item.stage} />
				{item.reviews && (
					<span className="inline-flex items-center gap-2">
						<Arm name="code" state={item.reviews.code} />
						<Arm name="sec" state={item.reviews.sec} />
					</span>
				)}
				{item.ci && item.ci !== 'none' && <Badge variant={CI_TONE[item.ci]}>CI {item.ci}</Badge>}
				{item.merge && item.merge !== 'CLEAN' && <Badge variant="warning">{item.merge}</Badge>}
				{item.dependabot && <Badge variant="outline">dependabot</Badge>}
				{item.assignees.length > 0 && (
					<span className="text-xs text-muted-foreground">@{item.assignees.join(', @')}</span>
				)}
			</div>
		</div>
	)
}

function RepoBoard({ repo, now }: { repo: Repo; now: number }) {
	const s = repo.state
	const counts = STAGES.map(
		(st) => [st, s?.board.filter((i) => i.stage === st).length ?? 0] as const
	)
	return (
		<Card className={cn(!repo.enabled && 'opacity-60')}>
			<CardHeader>
				<div className="flex flex-wrap items-center gap-2">
					<GitPullRequest className="size-4 text-muted-foreground" />
					<CardTitle>{repo.repo}</CardTitle>
					{!repo.enabled && <Badge variant="muted">disabled</Badge>}
					{s?.halt && <Badge variant="danger">halted: {s.halt}</Badge>}
					{s?.releaseGated && (
						<Badge variant="warning">
							<Shield className="size-3" />
							release gated
						</Badge>
					)}
					<span className="ml-auto text-xs text-muted-foreground">
						{repo.enabled &&
							`next tick ${repo.nextTick > now ? `in ${ago(repo.nextTick - now)}` : 'due'}`}
					</span>
				</div>
				{s?.summary && <p className="text-sm text-muted-foreground">{s.summary}</p>}
				<div className="flex flex-wrap gap-1.5">
					{counts
						.filter(([, n]) => n > 0)
						.map(([st, n]) => (
							<Badge key={st} variant={STAGE_TONE[st]}>
								{st} {n}
							</Badge>
						))}
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-2">
				{s?.errors.map((e) => (
					<div key={e} className="rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-500">
						{e}
					</div>
				))}
				{s?.warnings.map((w) => (
					<div key={w} className="rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-500">
						{w}
					</div>
				))}
				{!s && (
					<p className="text-sm text-muted-foreground">
						Waiting for the first tick of {short(repo.repo)}…
					</p>
				)}
				{s?.board.map((i) => (
					<Item key={`${i.kind}-${i.number}`} item={i} />
				))}
				{s && s.board.length === 0 && (
					<p className="text-sm text-muted-foreground">Nothing in the loop.</p>
				)}
			</CardContent>
		</Card>
	)
}

export function Boards({ view }: { view: DashboardView }) {
	if (view.repos.length === 0) return <GettingStarted view={view} />
	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-4 xl:grid-cols-2">
				{view.repos.map((r) => (
					<RepoBoard key={r.repo} repo={r} now={view.now} />
				))}
				<Link
					to="/repos"
					className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground hover:bg-accent/50"
				>
					<Plus className="size-4" />
					Add repo
				</Link>
			</div>
			{!progress(view).issue && <GettingStarted view={view} />}
		</div>
	)
}
