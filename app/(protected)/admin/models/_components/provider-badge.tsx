"use client"

import { Badge } from "@/components/ui/badge"
import {
  IconBrandOpenai,
  IconBrandAws,
  IconBrandGoogle,
  IconBrandAzure,
  IconBrain,
} from "@tabler/icons-react"
import { cn } from "@/lib/utils"

type ProviderVariant = "default" | "openai" | "bedrock" | "google" | "azure"

interface ProviderBadgeProps {
  provider: string
  showIcon?: boolean
  className?: string
}

const providerConfig: Record<
  string,
  { label: string; variant: ProviderVariant; icon: React.ComponentType<{ className?: string }> }
> = {
  openai: {
    label: "OpenAI",
    variant: "openai",
    icon: IconBrandOpenai,
  },
  azure: {
    label: "Azure",
    variant: "azure",
    icon: IconBrandAzure,
  },
  "amazon-bedrock": {
    label: "Bedrock",
    variant: "bedrock",
    icon: IconBrandAws,
  },
  google: {
    label: "Google",
    variant: "google",
    icon: IconBrandGoogle,
  },
  "google-vertex": {
    label: "Vertex AI",
    variant: "google",
    icon: IconBrandGoogle,
  },
}

const variantStyles: Record<ProviderVariant, string> = {
  default: "bg-gray-100 text-gray-800 hover:bg-gray-100",
  openai: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
  bedrock: "bg-orange-100 text-orange-800 hover:bg-orange-100",
  google: "bg-blue-100 text-blue-800 hover:bg-blue-100",
  azure: "bg-cyan-100 text-cyan-800 hover:bg-cyan-100",
}

export function ProviderBadge({ provider, showIcon = true, className }: ProviderBadgeProps) {
  const normalizedProvider = provider.toLowerCase()
  const config = providerConfig[normalizedProvider] || {
    label: provider,
    variant: "default" as const,
    icon: IconBrain,
  }

  const Icon = config.icon

  return (
    <Badge
      variant="secondary"
      className={cn(
        "font-medium",
        variantStyles[config.variant],
        className
      )}
    >
      {showIcon && <Icon className="h-3 w-3 mr-1" />}
      {config.label}
    </Badge>
  )
}

// Provider options for select dropdowns
export const PROVIDER_OPTIONS = [
  { value: "openai", label: "OpenAI" },
  { value: "azure", label: "Azure OpenAI" },
  { value: "amazon-bedrock", label: "Amazon Bedrock" },
  { value: "google", label: "Google AI" },
  { value: "google-vertex", label: "Google Vertex AI" },
] as const

export type ProviderValue = (typeof PROVIDER_OPTIONS)[number]["value"]
