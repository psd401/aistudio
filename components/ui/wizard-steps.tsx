"use client"

import { cn } from "@/lib/utils"
import Link from "next/link"

interface Step {
  number: number
  title: string
  href: string
  isCurrent: boolean
  isComplete: boolean
}

interface WizardStepsProps {
  steps: Step[]
  className?: string
}

export function WizardSteps({ steps, className }: WizardStepsProps) {
  return (
    <div className={cn("w-full", className)}>
      <div className="relative flex items-center justify-between">
        {steps.map((step, index) => (
          <div key={step.number} className="flex items-center">
            <div className="flex flex-col items-center relative">
              <Link
                href={step.href}
                className={cn(
                  "flex h-12 w-12 items-center justify-center rounded-full border-2 text-lg font-semibold",
                  step.isCurrent && "border-blue-500 bg-blue-500 text-white",
                  step.isComplete && "border-blue-500 bg-card text-blue-500",
                  !step.isCurrent && !step.isComplete && "border-gray-300 bg-card text-gray-300"
                )}
              >
                {step.number}
              </Link>
              <span
                className={cn(
                  "mt-2 text-sm whitespace-nowrap",
                  step.isCurrent && "text-blue-500 font-medium",
                  step.isComplete && "text-blue-500",
                  !step.isCurrent && !step.isComplete && "text-gray-500"
                )}
              >
                {step.title}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "h-[2px] flex-1 mx-4",
                  (step.isComplete || steps[index + 1].isComplete) ? "bg-blue-500" : "bg-gray-300"
                )}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
} 