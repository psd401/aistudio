import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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