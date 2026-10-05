import type { TaskRecord } from '@repo-ai/daemon/history'
import type { DashboardView } from '~/lib/api'
import { cn } from '~/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { ago, clock, short, usd } from './common'

type Profile = DashboardView['config']['agents'][number]

const DEFAULT_COLOR = '#64748b'
const VERDICT_TONE: Record<TaskRecord['verdict'], string> = {
	PASS: 'bg-emerald-500/15 text-emerald-500',
	'PASS-NOTES': 'bg-emerald-500/15 text-emerald-500',
	CHANGES: 'bg-amber-500/15 text-amber-500',
	DONE: 'bg-sky-500/15 text-sky-500',
	FAILED: 'bg-red-500/15 text-red-500',
}

/** The agent bound to a worker slot (#307); history and tasks are keyed by the worker id. */
const profileOf = (view: DashboardView, id: string): Profile | undefined =>
	view.config.agents.find((a) => a.slot === id)
const label = (p: Profile | undefined, id: string) => p?.name ?? id
const startOfDay = () => new Date().setHours(0, 0, 0, 0)

/** Inline SVG: no chart dependency for one polyline. Cumulative tokens over the records given. */
function Spark({ values, color }: { values: number[]; color: string }) {
	if (values.length < 2)
		return <div className="h-8 text-xs text-muted-foreground">not enough history</div>
	const max = Math.max(...values, 1)
	const pts = values
		.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - (v / max) * 28}`)
		.join(' ')
	return (
		<svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-8 w-full" aria-hidden="true">
			<polyline
				points={pts}
				fill="none"
				stroke={color}
				strokeWidth="1.5"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	)
}

export function Kpis({ view }: { view: DashboardView }) {
	const since = startOfDay()
	const today = view.history.filter((r) => r.t >= since)
	const inReview = view.repos.reduce(
		(n, r) => n + (r.state?.board.filter((i) => i.stage === 'review').length ?? 0),
		0
	)
	const merged = view.repos.reduce((n, r) => n + (r.state?.mergedToday ?? 0), 0)
	const budget = view.config.agents.reduce((n, a) => n + (a.costBudgetUsd ?? 0), 0)
	const tiles: [string, string][] = [
		['PRs merged today', String(merged)],
		['In review', String(inReview)],
		['PRs opened today', String(today.filter((r) => r.kind === 'implement' && r.ok).length)],
		['Tokens today', view.today.outputTokens.toLocaleString()],
		[
			'Spend today',
			budget ? `${usd(view.today.costUsd)} / ${usd(budget)}` : usd(view.today.costUsd),
		],
		['Tasks run', String(view.today.tasks)],
		['Failures', String(today.filter((r) => !r.ok).length)],
	]
	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
			{tiles.map(([k, v]) => (
				<Card key={k}>
					<CardContent className="p-4">
						<div className="text-xs text-muted-foreground">{k}</div>
						<div className="text-xl font-semibold tabular-nums">{v}</div>
					</CardContent>
				</Card>
			))}
		</div>
	)
}

function AgentCard({ view, id, online }: { view: DashboardView; id: string; online: boolean }) {
	const p = profileOf(view, id)
	const color = p?.color ?? DEFAULT_COLOR
	const running = view.tasks.find((t) => t.worker === id && t.state === 'running')
	const mine = view.history.filter((r) => r.agent === id)
	const spent = mine.filter((r) => r.t >= startOfDay()).reduce((n, r) => n + r.costUsd, 0)
	let cum = 0
	const tokens = mine.slice(-30).map((r) => (cum += r.outputTokens))
	return (
		<Card className="overflow-hidden" style={{ borderTop: `3px solid ${color}` }}>
			<CardContent className="flex flex-col gap-2 p-4">
				<div className="flex items-center gap-2">
					<span
						className="flex size-8 items-center justify-center rounded-full text-sm"
						style={{ background: `${color}33`, color }}
					>
						{p?.avatar ?? label(p, id).slice(0, 2).toUpperCase()}
					</span>
					<div className="min-w-0">
						<div className="truncate text-sm font-medium" style={{ color }}>
							{label(p, id)}
						</div>
						<div className="truncate text-xs text-muted-foreground">
							{p?.runner ?? 'claude'}
							{p?.model ? ` · ${p.model}` : ''}
						</div>
					</div>
					<span
						className={cn(
							'ml-auto size-2 rounded-full',
							online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
						)}
						title={online ? 'online' : 'offline'}
					/>
				</div>
				<div className="min-h-10 text-xs">
					{running ? (
						<>
							<div className="font-mono">
								{short(running.repo)} #{running.number} · {running.label} ·{' '}
								{ago(view.now - (running.startedAt ?? view.now))}
							</div>
							<div className="truncate text-muted-foreground">{running.progress}</div>
						</>
					) : (
						<span className="text-muted-foreground">idle</span>
					)}
				</div>
				<Spark values={tokens} color={color} />
				<div className="flex flex-wrap gap-1">
					{mine.slice(-6).map((r) => (
						<span
							key={`${r.t}-${r.number}-${r.label}`}
							title={`${r.label} #${r.number}`}
							className={cn(
								'rounded px-1.5 py-0.5 text-[10px] font-medium',
								VERDICT_TONE[r.verdict]
							)}
						>
							{r.verdict}
						</span>
					))}
				</div>
				<div className="text-xs">
					<div className="flex justify-between text-muted-foreground">
						<span>today</span>
						<span className="tabular-nums">
							{usd(spent)}
							{p?.costBudgetUsd ? ` / ${usd(p.costBudgetUsd)}` : ''}
						</span>
					</div>
					{p?.costBudgetUsd ? (
						<div className="mt-1 h-1.5 rounded-full bg-muted">
							<div
								className="h-full rounded-full"
								style={{
									width: `${Math.min(100, (spent / p.costBudgetUsd) * 100)}%`,
									background: color,
								}}
							/>
						</div>
					) : null}
				</div>
			</CardContent>
		</Card>
	)
}

export function AgentCards({ view }: { view: DashboardView }) {
	if (view.workers.length === 0) return null
	return (
		<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			{view.workers.map((w) => (
				<AgentCard key={w.id} view={view} id={w.id} online={w.online} />
			))}
		</div>
	)
}

export function DecisionStream({ view }: { view: DashboardView }) {
	const rows = view.history.slice(-30).reverse()
	return (
		<Card>
			<CardHeader>
				<CardTitle>Decision stream</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-1.5">
				{rows.length === 0 && <p className="text-sm text-muted-foreground">No decisions yet.</p>}
				{rows.map((r) => (
					<div
						key={`${r.t}-${r.agent}-${r.number}-${r.label}`}
						className="flex items-center gap-2 text-xs"
					>
						<span className="shrink-0 font-mono text-muted-foreground">{clock(r.t)}</span>
						<span
							className="shrink-0"
							style={{ color: profileOf(view, r.agent)?.color ?? DEFAULT_COLOR }}
						>
							{label(profileOf(view, r.agent), r.agent)}
						</span>
						<span
							className={cn('shrink-0 rounded px-1.5 py-0.5 font-medium', VERDICT_TONE[r.verdict])}
						>
							{r.verdict}
						</span>
						<span className="min-w-0 truncate font-mono">
							{short(r.repo)} #{r.number}
						</span>
						<span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
							{ago(r.durationMs)}
						</span>
					</div>
				))}
			</CardContent>
		</Card>
	)
}

/** Ranked by completed tasks; there is no merge record (agents never merge), so cost is per completed task. */
export function Leaderboard({ view }: { view: DashboardView }) {
	const ids = [...new Set(view.history.map((r) => r.agent))]
	const rows = ids
		.map((id) => {
			const mine = view.history.filter((r) => r.agent === id)
			const done = mine.filter((r) => r.ok).length
			return {
				id,
				done,
				rate: mine.length ? done / mine.length : 0,
				perTask: done ? mine.reduce((n, r) => n + r.costUsd, 0) / done : 0,
			}
		})
		.sort((a, b) => b.done - a.done || b.rate - a.rate)
	return (
		<Card>
			<CardHeader>
				<CardTitle>Leaderboard</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-1.5">
				{rows.length === 0 && (
					<p className="text-sm text-muted-foreground">No finished tasks yet.</p>
				)}
				{rows.map((r, i) => (
					<div key={r.id} className="flex items-center gap-2 text-sm">
						<span className="w-4 text-muted-foreground">{i + 1}</span>
						<span style={{ color: profileOf(view, r.id)?.color ?? DEFAULT_COLOR }}>
							{label(profileOf(view, r.id), r.id)}
						</span>
						<span className="ml-auto tabular-nums text-xs text-muted-foreground">
							{r.done} done · {Math.round(r.rate * 100)}% ok · {usd(r.perTask)}/task
						</span>
					</div>
				))}
			</CardContent>
		</Card>
	)
}
