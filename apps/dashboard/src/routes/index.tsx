import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
	Activity as ActivityIcon,
	AlertTriangle,
	Bot,
	LayoutGrid,
	Moon,
	Settings,
	Sun,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Activity } from '~/components/activity'
import { Agents } from '~/components/agents'
import { Boards } from '~/components/board'
import { Setup } from '~/components/setup'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { type DashboardView, getState } from '~/lib/api'

export const Route = createFileRoute('/')({ component: Dashboard })

const KEY = ['state'] as const

function Header({ view, error }: { view: DashboardView | undefined; error: Error | null }) {
	const [dark, setDark] = useState(true)
	useEffect(() => setDark(localStorage.getItem('theme') !== 'light'), [])
	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark)
		localStorage.setItem('theme', dark ? 'dark' : 'light')
	}, [dark])
	const online = view?.workers.filter((w) => w.online).length ?? 0
	const running = view?.tasks.filter((t) => t.state === 'running').length ?? 0
	return (
		<header className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
			<h1 className="mr-4 text-lg font-semibold">repo-ai</h1>
			{view && (
				<>
					<Badge variant="outline">{view.repos.length} repos</Badge>
					<Badge variant={online > 0 ? 'success' : 'danger'}>
						{online}/{view.workers.length} workers online
					</Badge>
					<Badge variant={running > 0 ? 'info' : 'muted'}>{running} running</Badge>
					{!view.app && (
						<Badge variant="danger">
							<AlertTriangle className="size-3" />
							no GitHub App credentials
						</Badge>
					)}
					{!view.workerSecret && (
						<Badge variant="danger">
							<AlertTriangle className="size-3" />
							worker secret unset
						</Badge>
					)}
				</>
			)}
			{error && (
				<Badge variant="danger">
					<AlertTriangle className="size-3" />
					{error.message}
				</Badge>
			)}
			<Button
				variant="ghost"
				size="icon"
				className="ml-auto"
				aria-label="toggle theme"
				onClick={() => setDark(!dark)}
			>
				{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
			</Button>
		</header>
	)
}

function Dashboard() {
	const qc = useQueryClient()
	const { data: view, error } = useQuery({
		queryKey: KEY,
		queryFn: () => getState(),
		refetchInterval: 5000,
		placeholderData: keepPreviousData,
	})
	return (
		<div className="min-h-screen">
			<Header view={view} error={error} />
			<main className="p-6">
				{!view ? (
					<p className="text-sm text-muted-foreground">
						{error ? 'Cannot reach the API.' : 'Loading…'}
					</p>
				) : (
					<Tabs defaultValue="board">
						<TabsList>
							<TabsTrigger value="board">
								<LayoutGrid className="size-4" />
								Board
							</TabsTrigger>
							<TabsTrigger value="agents">
								<Bot className="size-4" />
								Agents
							</TabsTrigger>
							<TabsTrigger value="activity">
								<ActivityIcon className="size-4" />
								Activity
							</TabsTrigger>
							<TabsTrigger value="setup">
								<Settings className="size-4" />
								Setup
							</TabsTrigger>
						</TabsList>
						<TabsContent value="board">
							<Boards view={view} />
						</TabsContent>
						<TabsContent value="agents">
							<Agents view={view} />
						</TabsContent>
						<TabsContent value="activity">
							<Activity view={view} />
						</TabsContent>
						<TabsContent value="setup">
							<Setup view={view} onSaved={(v) => qc.setQueryData(KEY, v)} />
						</TabsContent>
					</Tabs>
				)}
			</main>
		</div>
	)
}
