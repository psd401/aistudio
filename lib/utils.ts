import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Validate that a URL uses a safe protocol (http or https only).
 * Prevents XSS attacks via javascript:, data:, file:, and other dangerous protocols.
 *
 * @param url - URL string to validate
 * @returns true if URL uses http: or https: protocol, false otherwise
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Generates a URL-friendly identifier from a tool name.
 * Used when creating tools in the base tools system.
 * 
 * @param name - The name of the tool to generate an identifier from
 * @returns A lowercase, hyphenated string with only alphanumeric characters
 * 
 * Example:
 * "My Cool Tool!" -> "my-cool-tool"
 */
export function generateToolIdentifier(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\da-z]+/g, '-')
    .replace(/^-+|-+$/g, '')
}