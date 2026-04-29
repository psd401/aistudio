import type { Metadata } from "next"
import type { Prompt } from "@/lib/prompt-library/types"

/**
 * Generate metadata for a specific prompt detail page
 */
export function generatePromptMetadata(prompt: Prompt): Metadata {
  const title = `${prompt.title} - AI Prompt Library`
  const description =
    prompt.description || prompt.content.substring(0, 155) + "..."

  return {
    title,
    description,
    openGraph: {
      title: prompt.title,
      description,
      type: "article",
      publishedTime: prompt.createdAt,
      modifiedTime: prompt.updatedAt,
      authors: prompt.ownerName ? [prompt.ownerName] : undefined,
      tags: prompt.tags
    },
    twitter: {
      card: "summary",
      title: prompt.title,
      description
    },
    keywords: prompt.tags?.join(", ")
  }
}

/**
 * Generate structured data (JSON-LD) for SEO
 */
export function generatePromptStructuredData(prompt: Prompt) {
  return {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: prompt.title,
    description: prompt.description || undefined,
    text: prompt.content,
    dateCreated: prompt.createdAt,
    dateModified: prompt.updatedAt,
    author: {
      "@type": "Person",
      name: prompt.ownerName || "Anonymous"
    },
    keywords: prompt.tags?.join(", "),
    interactionStatistic: [
      {
        "@type": "InteractionCounter",
        interactionType: "https://schema.org/UseAction",
        userInteractionCount: prompt.useCount
      },
      {
        "@type": "InteractionCounter",
        interactionType: "https://schema.org/ViewAction",
        userInteractionCount: prompt.viewCount
      }
    ]
  }
}

/**
 * Generate structured data for the public gallery
 */
export function generateGalleryStructuredData(orgName = 'Your Organization', orgUrl = '') {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "AI Prompt Library",
    description:
      "Browse and discover community-created AI prompts for education and administration",
    provider: {
      "@type": "Organization",
      name: orgName,
      ...(orgUrl ? { url: orgUrl } : {}),
    },
    about: {
      "@type": "Thing",
      name: "Artificial Intelligence Prompts",
      description:
        "A curated collection of AI prompts for educational purposes"
    }
  }
}
