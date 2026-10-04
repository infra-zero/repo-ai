import { Link } from '@tanstack/react-router'
import { Bot, Check, Cpu, GitBranch, KeyRound, Tag } from 'lucide-react'
import type { DashboardView } from '~/lib/api'
import { cn } from '~/lib/utils'
import { Card, CardContent } from './ui/card'

/** What is done so far, from the api's state alone. */
export function progress(view: DashboardView) {
	return {
		app: view.app,
		repo: view.repos.length > 0,
		agent: view.config.agents.length > 0,
		issue: view.repos.some((r) => (r.state?.board.length ?? 0) > 0),
		model: view.credentials.length > 0,
	}
}

const CARDS = [
	{
		k: 'app',
		to: '/setup',
		icon: KeyRound,
		title: 'Connect the GitHub App',
		text: 'The api acts as this App. Credentials load from docker/.env.',
	},
	{
		k: 'repo',
		to: '/repos',
		icon: GitBranch,
		title: 'Add a repo',
		text: 'Pick the repos the loop works.',
	},
	{
		k: 'agent',
		to: '/agents',
		icon: Bot,
		title: 'Add an agent',
		text: 'Bind a profile to a free worker slot; it picks up the tasks.',
	},
	{
		k: 'issue',
		to: '/repos',
		icon: Tag,
		title: 'Label your first issue ai-ready',
		text: 'The loop only touches issues you label.',
	},
	{
		k: 'model',
		to: '/models',
		icon: Cpu,
		title: 'Pick a model',
		text: 'Give agents a model credential.',
	},
] as const

export function GettingStarted({ view }: { view: DashboardView }) {
	const p = progress(view)
	return (
		<div className="flex flex-col gap-3">
			<div>
				<h2 className="text-lg font-semibold">Getting started</h2>
				<p className="text-sm text-muted-foreground">Five steps from nothing to a merged PR.</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{CARDS.map((c) => (
					<Link
						key={c.k}
						to={c.to}
						className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring"
					>
						<Card
							className={cn('h-full transition-colors hover:bg-accent/50', p[c.k] && 'opacity-70')}
						>
							<CardContent className="flex gap-3 p-4">
								<c.icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2 font-medium">
										{c.title}
										{p[c.k] && <Check aria-label="done" className="size-4 text-emerald-500" />}
									</div>
									<p className="text-xs text-muted-foreground">{c.text}</p>
								</div>
							</CardContent>
						</Card>
					</Link>
				))}
			</div>
		</div>
	)
}
