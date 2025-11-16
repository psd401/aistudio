/**
 * Type helper functions for safe type conversions
 */

/**
 * Ensures a value is a number, converting strings if necessary
 */
export function ensureNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Ensures a value is a string
 */
export function ensureString(value: unknown): string {
  return value != null ? String(value) : '';
}

/**
 * Ensures a value is a boolean
 */
export function ensureBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return false;
}

/**
 * Safely converts a value to a number or returns null
 */
export function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Safely converts a value to a string or returns null
 */
export function toStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

/**
 * Type guard to check if a value is not null or undefined
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

/**
 * Ensures an array contains only defined values
 */
export function filterDefined<T>(array: (T | null | undefined)[]): T[] {
  return array.filter(isDefined);
}

/**
 * RDS Data API specific type helpers
 */

// RDS Data API Field value type
import type { ArrayValue } from "@aws-sdk/client-rds-data";

export type RDSFieldValue = string | number | boolean | Uint8Array | ArrayValue | null | undefined | unknown;

/**
 * Type guard to check if RDS field value is a string
 */
export function isRDSString(value: RDSFieldValue): value is string {
  return typeof value === 'string';
}

/**
 * Type guard to check if RDS field value is a number
 */
export function isRDSNumber(value: RDSFieldValue): value is number {
  return typeof value === 'number';
}

/**
 * Type guard to check if RDS field value is a boolean
 */
export function isRDSBoolean(value: RDSFieldValue): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Safely extracts a string from RDS field value
 */
export function extractRDSString(value: RDSFieldValue): string | null {
  if (value === null) return null;
  if (isRDSString(value)) return value;
  if (isRDSNumber(value) || isRDSBoolean(value)) return String(value);
  return null;
}

/**
 * Safely extracts a number from RDS field value
 */
export function extractRDSNumber(value: RDSFieldValue): number | null {
  if (value === null) return null;
  if (isRDSNumber(value)) return value;
  if (isRDSString(value)) {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Safely extracts a boolean from RDS field value
 */
export function extractRDSBoolean(value: RDSFieldValue): boolean {
  if (isRDSBoolean(value)) return value;
  if (isRDSNumber(value)) return value !== 0;
  if (isRDSString(value)) return value.toLowerCase() === 'true' || value === '1';
  return false;
}

/**
 * Ensures RDS field value is a string (never null)
 */
export function ensureRDSString(value: RDSFieldValue): string {
  return extractRDSString(value) || '';
}

/**
 * Ensures RDS field value is a number (never null)
 */
export function ensureRDSNumber(value: RDSFieldValue): number {
  return extractRDSNumber(value) || 0;
}

/**
 * Type helper for React key prop
 */
export function toReactKey(value: RDSFieldValue): string | number {
  if (isRDSString(value) || isRDSNumber(value)) return value;
  return String(value);
}

