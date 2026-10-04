import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { AppSidebar } from '~/components/app-sidebar'
import { Topbar } from '~/components/topbar'
import { SidebarInset, SidebarProvider } from '~/components/ui/sidebar'
import { TooltipProvider } from '~/components/ui/tooltip'
import css from '~/styles.css?url'

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: 'utf-8' },
			{ name: 'viewport', content: 'width=device-width, initial-scale=1' },
			{ title: 'repo-ai dashboard' },
		],
		links: [{ rel: 'stylesheet', href: css }],
	}),
	component: () => (
		<html lang="en" className="dark" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body>
				<TooltipProvider delayDuration={150}>
					<SidebarProvider>
						<AppSidebar />
						<SidebarInset className="min-w-0">
							<Topbar />
							<main className="min-w-0 flex-1 p-4 md:p-6">
								<Outlet />
							</main>
						</SidebarInset>
					</SidebarProvider>
				</TooltipProvider>
				<Scripts />
			</body>
		</html>
	),
})
