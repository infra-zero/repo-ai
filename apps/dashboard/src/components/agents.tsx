import { AlertTriangle } from 'lucide-react'
import type { DashboardView } from '~/lib/api'
import { cn } from '~/lib/utils'
import { Badge } from './ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { ago, clock, short, usd } from './common'

export function Agents({ view }: { view: DashboardView }) {
	const task = (id?: string) => view.tasks.find((t) => t.id === id)
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
				<CardHeader>
					<CardTitle>Workers</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Worker</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Task</TableHead>
								<TableHead>Progress</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{view.workers.map((w) => {
								const t = task(w.task)
								const p = Object.hasOwn(view.config.workers, w.id)
									? view.config.workers[w.id]
									: undefined
								return (
									<TableRow key={w.id}>
										<TableCell>
											<span className="flex items-center gap-2">
												<span
													className={cn(
														'size-2 rounded-full',
														w.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
													)}
												/>
												{p?.avatar && <span>{p.avatar}</span>}
												<span style={p?.color ? { color: p.color } : undefined}>
													{p?.name ?? <span className="font-mono">{w.id}</span>}
												</span>
												{p?.name && (
													<span className="font-mono text-xs text-muted-foreground">{w.id}</span>
												)}
												{p?.model && <Badge variant="muted">{p.model}</Badge>}
												{w.claudeAuth === false && !p?.credentials?.length && (
													<Badge variant="danger">
														<AlertTriangle className="size-3" />
														no Claude credential
													</Badge>
												)}
											</span>
										</TableCell>
										<TableCell>
											<Badge variant="muted">{w.role}</Badge>
										</TableCell>
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
												<span className="text-muted-foreground">idle</span>
											)}
										</TableCell>
										<TableCell className="max-w-md truncate text-xs text-muted-foreground">
											{t?.progress}
										</TableCell>
									</TableRow>
								)
							})}
							{view.workers.length === 0 && (
								<TableRow>
									<TableCell colSpan={4} className="text-muted-foreground">
										No workers have connected yet.
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
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
