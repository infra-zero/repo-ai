import { Tabs as TabsPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '~/lib/utils'

export const Tabs = TabsPrimitive.Root
export const TabsList = ({ className, ...p }: React.ComponentProps<typeof TabsPrimitive.List>) => (
	<TabsPrimitive.List
		className={cn('inline-flex h-9 items-center rounded-lg bg-muted p-1', className)}
		{...p}
	/>
)
export const TabsTrigger = ({
	className,
	...p
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) => (
	<TabsPrimitive.Trigger
		className={cn(
			'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm',
			className
		)}
		{...p}
	/>
)
export const TabsContent = ({
	className,
	...p
}: React.ComponentProps<typeof TabsPrimitive.Content>) => (
	<TabsPrimitive.Content className={cn('mt-4 outline-none', className)} {...p} />
)
