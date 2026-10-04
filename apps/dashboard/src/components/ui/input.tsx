import type * as React from 'react'
import { cn } from '~/lib/utils'

export const Input = ({ className, ...p }: React.ComponentProps<'input'>) => (
	<input
		className={cn(
			'h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring',
			className
		)}
		{...p}
	/>
)
