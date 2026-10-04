import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
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
					<Outlet />
				</TooltipProvider>
				<Scripts />
			</body>
		</html>
	),
})
