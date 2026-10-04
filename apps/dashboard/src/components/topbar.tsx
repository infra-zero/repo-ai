import { Link, useRouterState } from '@tanstack/react-router'
import { AlertTriangle, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { Button } from '~/components/ui/button'
import { Separator } from '~/components/ui/separator'
import { SidebarTrigger } from '~/components/ui/sidebar'
import { useDashboard } from '~/lib/use-dashboard'
import { Badge } from './ui/badge'

const TITLES: Record<string, string> = {
	'/': 'Board',
	'/agents': 'Agents',
	'/activity': 'Activity',
	'/repos': 'Repos',
	'/models': 'Models',
	'/settings': 'Settings',
	'/setup': 'Setup',
}

function ThemeToggle() {
	const [dark, setDark] = useState(true)
	useEffect(() => setDark(localStorage.getItem('theme') !== 'light'), [])
	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark)
		localStorage.setItem('theme', dark ? 'dark' : 'light')
	}, [dark])
	return (
		<Button variant="ghost" size="icon" aria-label="toggle theme" onClick={() => setDark(!dark)}>
			{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
		</Button>
	)
}

export function Topbar() {
	const { data: view, error } = useDashboard()
	const { pathname, search } = useRouterState({ select: (s) => s.location })
	const repo = (search as { repo?: string }).repo
	const online = view?.workers.filter((w) => w.online).length ?? 0
	const running = view?.tasks.filter((t) => t.state === 'running').length ?? 0
	const warnings = [
		view && !view.app && 'no GitHub App credentials',
		view && !view.workerSecret && 'worker secret unset',
		error?.message,
	].filter((w): w is string => !!w)

	return (
		<header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 transition-[height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 md:px-4">
			<SidebarTrigger className="-ml-1" />
			<Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
			<Breadcrumb className="min-w-0">
				<BreadcrumbList className="flex-nowrap">
					<BreadcrumbItem className="hidden md:block">
						<Link to="/" search={{}} className="hover:text-foreground">
							repo-ai
						</Link>
					</BreadcrumbItem>
					<BreadcrumbSeparator className="hidden md:block" />
					<BreadcrumbItem>
						{repo ? (
							<Link to="/" search={{}} className="hover:text-foreground">
								{TITLES[pathname]}
							</Link>
						) : (
							<BreadcrumbPage>{TITLES[pathname] ?? ''}</BreadcrumbPage>
						)}
					</BreadcrumbItem>
					{repo && (
						<>
							<BreadcrumbSeparator />
							<BreadcrumbItem className="min-w-0">
								<BreadcrumbPage className="truncate">{repo}</BreadcrumbPage>
							</BreadcrumbItem>
						</>
					)}
				</BreadcrumbList>
			</Breadcrumb>
			<div className="ml-auto flex shrink-0 items-center gap-1.5">
				{view && (
					<>
						<Badge variant={online > 0 ? 'success' : 'danger'}>
							{online}/{view.workers.length}
							<span className="hidden sm:inline"> workers online</span>
						</Badge>
						<Badge variant={running > 0 ? 'info' : 'muted'} className="hidden sm:inline-flex">
							{running} running
						</Badge>
					</>
				)}
				{warnings.length > 0 && (
					<Badge variant="danger" title={warnings.join('\n')}>
						<AlertTriangle className="size-3" />
						{warnings.length}
						<span className="hidden lg:inline">
							{warnings.length === 1 ? ` ${warnings[0]}` : ' warnings'}
						</span>
					</Badge>
				)}
				<ThemeToggle />
			</div>
		</header>
	)
}
