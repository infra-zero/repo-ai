import { Link } from '@tanstack/react-router'
import { Check, Circle } from 'lucide-react'
import type { DashboardView } from '~/lib/api'
import { progress } from './getting-started'
import { AddRepo } from './repos'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'

/** First-run wizard: the step shown is the first one not yet done, read from the api's state. */
export function Setup({ view }: { view: DashboardView }) {
	const p = progress(view)
	const current = !p.app ? 1 : !p.repo ? 2 : !p.agent ? 3 : 4
	const steps = ['GitHub App', 'First repo', 'First agent']
	return (
		<div className="flex max-w-2xl flex-col gap-4">
			<ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
				{steps.map((t, i) => (
					<li
						key={t}
						className={`flex items-center gap-1.5 ${i + 1 === current ? 'font-medium' : 'text-muted-foreground'}`}
					>
						{i + 1 < current ? (
							<Check className="size-4 text-emerald-500" />
						) : (
							<Circle className="size-4" />
						)}
						{i + 1}. {t}
					</li>
				))}
			</ol>
			<Card>
				<CardHeader>
					<CardTitle>
						{current === 1 && '1. GitHub App credentials'}
						{current === 2 && '2. Add your first repo'}
						{current === 3 && '3. Add an agent'}
						{current === 4 && 'You are set up'}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-3 text-sm">
					{current === 1 && (
						<>
							<p>
								The api acts as a GitHub App and has no credentials yet. Put the App id and private
								key in <code>docker/.env</code> (the key as a file mounted into the api), then
								restart the stack. Values are never shown here.
							</p>
							<p className="text-muted-foreground">This page updates once the api sees them.</p>
						</>
					)}
					{current === 2 && (
						<>
							<p>The repo the loop should work, as owner/repo. The App must be installed on it.</p>
							<AddRepo view={view} />
						</>
					)}
					{current === 3 && (
						<>
							<p>
								Compose runs worker slots; an agent is a profile bound to one. Once a slot connects,
								add an agent for it on the Agents page.
							</p>
							{view.workers.length === 0 ? (
								<p className="text-muted-foreground">Waiting for a worker slot…</p>
							) : (
								<Button asChild className="w-fit">
									<Link to="/agents">Add an agent</Link>
								</Button>
							)}
						</>
					)}
					{current === 4 && (
						<Button asChild className="w-fit">
							<Link to="/">Go to the Board</Link>
						</Button>
					)}
				</CardContent>
			</Card>
		</div>
	)
}
