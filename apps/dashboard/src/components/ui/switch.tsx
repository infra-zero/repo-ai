import { Switch as SwitchPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '~/lib/utils'

export const Switch = ({ className, ...p }: React.ComponentProps<typeof SwitchPrimitive.Root>) => (
	<SwitchPrimitive.Root
		className={cn(
			'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-primary',
			className
		)}
		{...p}
	>
		<SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-foreground transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-primary-foreground" />
	</SwitchPrimitive.Root>
)
