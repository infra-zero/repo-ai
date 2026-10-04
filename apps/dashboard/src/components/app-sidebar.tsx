import { Link, useRouterState } from '@tanstack/react-router'
import {
	Activity,
	Bot,
	ChevronsUpDown,
	Cpu,
	FolderGit2,
	GitBranch,
	GitPullRequest,
	LayoutGrid,
	Settings,
	ShieldAlert,
	ShieldCheck,
} from 'lucide-react'
import type * as React from 'react'
import { Avatar, AvatarFallback } from '~/components/ui/avatar'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSkeleton,
	SidebarRail,
	useSidebar,
} from '~/components/ui/sidebar'
import { useDashboard } from '~/lib/use-dashboard'

const NAV = [
	{ to: '/', title: 'Board', icon: LayoutGrid },
	{ to: '/repos', title: 'Repos', icon: FolderGit2 },
	{ to: '/agents', title: 'Agents', icon: Bot },
	{ to: '/models', title: 'Models', icon: Cpu },
	{ to: '/activity', title: 'Activity', icon: Activity },
	{ to: '/settings', title: 'Settings', icon: Settings },
] as const

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { data: view } = useDashboard()
	const { pathname, search } = useRouterState({ select: (s) => s.location })
	const { isMobile, setOpenMobile } = useSidebar()
	const closeSheet = () => isMobile && setOpenMobile(false)
	const activeRepo = (search as { repo?: string }).repo

	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<SidebarMenuButton
									size="lg"
									className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
								>
									<div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
										<GitBranch className="size-4" />
									</div>
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-medium">repo-ai</span>
										<span className="truncate text-xs">AI issue → PR loop</span>
									</div>
									<ChevronsUpDown className="ml-auto" />
								</SidebarMenuButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
								align="start"
								side={isMobile ? 'bottom' : 'right'}
								sideOffset={4}
							>
								<DropdownMenuLabel className="text-xs text-muted-foreground">
									Workspaces
								</DropdownMenuLabel>
								<DropdownMenuItem className="gap-2 p-2">
									<GitBranch className="size-4" />
									repo-ai
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Dashboard</SidebarGroupLabel>
					<SidebarMenu>
						{NAV.map((n) => (
							<SidebarMenuItem key={n.to}>
								<SidebarMenuButton
									asChild
									tooltip={n.title}
									isActive={
										n.to === '/'
											? pathname === '/' && !activeRepo
											: pathname === n.to || pathname.startsWith(`${n.to}/`)
									}
								>
									<Link to={n.to} search={n.to === '/' ? {} : undefined} onClick={closeSheet}>
										<n.icon />
										<span>{n.title}</span>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>

				<SidebarGroup>
					<SidebarGroupLabel>Repos</SidebarGroupLabel>
					<SidebarMenu>
						{!view && <SidebarMenuSkeleton showIcon />}
						{view?.repos.map((r) => (
							<SidebarMenuItem key={r.repo}>
								<SidebarMenuButton
									asChild
									tooltip={r.repo}
									isActive={pathname === '/' && activeRepo === r.repo}
									className={r.enabled ? undefined : 'opacity-60'}
								>
									<Link to="/" search={{ repo: r.repo }} onClick={closeSheet}>
										<GitPullRequest />
										<span>{r.repo.split('/')[1]}</span>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
						{view?.repos.length === 0 && (
							<p className="px-2 text-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
								None yet. Add one under Repos.
							</p>
						)}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>

			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<SidebarMenuButton
									size="lg"
									title="GitHub App menu"
									className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
								>
									<Avatar className="size-8 rounded-lg">
										<AvatarFallback className="rounded-lg">
											{view?.app ? (
												<ShieldCheck className="size-4 text-emerald-500" />
											) : (
												<ShieldAlert className="size-4 text-red-500" />
											)}
										</AvatarFallback>
									</Avatar>
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-medium">GitHub App</span>
										<span className="truncate text-xs">
											{!view ? 'connecting…' : view.app ? 'credentials loaded' : 'no credentials'}
										</span>
									</div>
									<ChevronsUpDown className="ml-auto size-4" />
								</SidebarMenuButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
								side={isMobile ? 'bottom' : 'right'}
								align="end"
								sideOffset={4}
							>
								<DropdownMenuLabel className="text-xs text-muted-foreground">
									The API runs as this GitHub App
								</DropdownMenuLabel>
								<DropdownMenuItem asChild>
									<Link to="/setup" onClick={closeSheet}>
										<Settings />
										Setup wizard
									</Link>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	)
}
