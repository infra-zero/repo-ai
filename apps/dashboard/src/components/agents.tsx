import { AlertTriangle, Plus } from 'lucide-react'
import { useState } from 'react'
import type { DashboardView } from '~/lib/api'
import { cn } from '~/lib/utils'
import { type Agent, AgentSheet, freeSlots } from './agent-sheet'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { ago, clock, short, usd } from './common'

/** Agents bound to slots, then the idle slots (#307). An agent's name opens its edit sheet. */
export function Agents({ view }: { view: DashboardView }) {
	const [sheet, setSheet] = useState<{ agent?: Agent } | null>(null)
	const task = (id?: string) => view.tasks.find((t) => t.id === id)
	const free = freeSlots(view)
	const rows = [
		...view.config.agents.map((a) => ({ a, w: view.workers.find((w) => w.id === a.slot) })),
		...free.map((id) => ({ a: undefined, w: view.workers.find((w) => w.id === id) })),
	]
	const queued = view.tasks.filter((t) => t.state === 'queued').length
	const failed = view.tasks
		.filter((t) => t.state === 'failed')
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
		.slice(0, 5)
	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				{[
					['Queued', queued],
					['Tasks today', view.today.tasks],
					['Output tokens today', view.today.outputTokens.toLocaleString()],
					['Cost today', usd(view.today.costUsd)],
				].map(([k, v]) => (
					<Card key={k}>
						<CardContent className="p-4">
							<div className="text-xs text-muted-foreground">{k}</div>
							<div className="text-2xl font-semibold tabular-nums">{v}</div>
						</CardContent>
					</Card>
				))}
			</div>
			<Card>
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
					<CardTitle>Agents</CardTitle>
					<span className="flex items-center gap-2">
						{free.length === 0 && (
							<span className="text-xs text-muted-foreground">
								No free slot — raise the worker count in <code>docker/compose.yml</code>.
							</span>
						)}
						<Button size="sm" disabled={free.length === 0} onClick={() => setSheet({})}>
							<Plus />
							Add agent
						</Button>
					</span>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Agent</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Task</TableHead>
								<TableHead>Progress</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map(({ a: p, w }) => {
								const t = task(w?.task)
								const slot = p?.slot ?? w?.id ?? ''
								return (
									<TableRow key={p?.id ?? slot} className={cn(!p && 'text-muted-foreground')}>
										<TableCell>
											<span className="flex items-center gap-2">
												<span
													className={cn(
														'size-2 rounded-full',
														w?.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
													)}
												/>
												{p ? (
													<button
														type="button"
														className="flex items-center gap-2 hover:underline"
														onClick={() => setSheet({ agent: p })}
													>
														{p.avatar && <span>{p.avatar}</span>}
														<span style={p.color ? { color: p.color } : undefined}>
															{p.name || p.id}
														</span>
													</button>
												) : (
													<span>idle slot</span>
												)}
												<span className="font-mono text-xs text-muted-foreground">{slot}</span>
												{p?.model && <Badge variant="muted">{p.model}</Badge>}
												{p && w?.claudeAuth === false && !p.credentials?.length && (
													<Badge variant="danger">
														<AlertTriangle className="size-3" />
														no agent credential
													</Badge>
												)}
											</span>
										</TableCell>
										<TableCell>{p && <Badge variant="muted">{p.role}</Badge>}</TableCell>
										<TableCell>
											{t ? (
												<span>
													<span className="font-mono">
														{short(t.repo)} #{t.number}
													</span>{' '}
													<span className="text-muted-foreground">
														{t.label} · {ago(view.now - (t.startedAt ?? view.now))}
													</span>
												</span>
											) : (
												<span className="text-muted-foreground">
													{!p ? 'takes no tasks' : w ? 'idle' : 'slot offline'}
												</span>
											)}
										</TableCell>
										<TableCell className="max-w-md truncate text-xs text-muted-foreground">
											{t?.progress}
										</TableCell>
									</TableRow>
								)
							})}
							{rows.length === 0 && (
								<TableRow>
									<TableCell colSpan={4} className="text-muted-foreground">
										No worker slots have connected yet.
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
			<AgentSheet
				view={view}
				agent={sheet?.agent}
				open={!!sheet}
				onOpenChange={(o) => !o && setSheet(null)}
			/>
			{failed.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Recent failures</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{failed.map((t) => (
							<div key={t.id} className="rounded-md border p-2 text-sm">
								<span className="font-mono">
									{short(t.repo)} #{t.number}
								</span>{' '}
								<span className="text-muted-foreground">
									{t.label} · {t.endedAt ? clock(t.endedAt) : ''}
								</span>
								<div className="break-words text-xs text-red-500">
									{t.result?.error ?? t.result?.summary}
								</div>
							</div>
						))}
					</CardContent>
				</Card>
			)}
		</div>
	)
}
