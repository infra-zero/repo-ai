import { Tooltip as TooltipPrimitive } from 'radix-ui'
import type * as React from 'react'

export const TooltipProvider = TooltipPrimitive.Provider

export function Tip({ text, children }: { text: string; children: React.ReactNode }) {
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					sideOffset={4}
					className="z-50 max-w-xs rounded-md bg-foreground px-2 py-1 text-xs text-background"
				>
					{text}
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	)
}
