import * as React from "react"
import { cn } from "@/lib/utils"

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "outline" | "profit" | "loss" | "live"
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors",
        {
          "bg-zinc-800 text-zinc-100": variant === "default",
          "border bg-transparent": variant === "outline",
          "border-emerald-500/30 text-emerald-400 bg-emerald-500/10": variant === "profit",
          "border-rose-500/30 text-rose-400 bg-rose-500/10": variant === "loss",
          "border-cyan-500/30 text-cyan-400 bg-cyan-500/10": variant === "live",
        },
        className
      )}
      {...props}
    />
  )
}

export { Badge }
