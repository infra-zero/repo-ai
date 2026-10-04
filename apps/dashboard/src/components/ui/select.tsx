import type * as React from 'react'
import { cn } from '~/lib/utils'

// ponytail: native <select> in shadcn styling; swap for Radix Select if a custom popover is wanted.
export const Select = ({ className, ...p }: React.ComponentProps<'select'>) => (
	<select
		className={cn(
			'h-9 rounded-md border bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
			className
		)}
		{...p}
	/>
)
