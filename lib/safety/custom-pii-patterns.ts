/**
 * District-specific PII patterns
 *
 * Add custom patterns here for identifiers specific to your district.
 * These are detected alongside Amazon Comprehend's built-in PII types.
 *
 * To add a new pattern:
 * 1. Add a new entry to this array
 * 2. Define the regex pattern (test it thoroughly!)
 * 3. Deploy the application (no infrastructure changes needed)
 *
 * Pattern tips:
 * - Use \b for word boundaries to avoid partial matches
 * - Test with edge cases (embedded in text, at start/end, multiple occurrences)
 * - Consider false positives (dates, phone numbers, etc.)
 *
 * Kept out of `types.ts` so that module stays declarations only: the student
 * number below is a value read from the canonical pattern file, and
 * everything that imports a type from `types.ts` should not load that file.
 */

import { PSD_STUDENT_ID_PATTERN } from "@/lib/safety/personal-data-scan";
import type { CustomPIIPattern } from "@/lib/safety/types";

export const CUSTOM_PII_PATTERNS: CustomPIIPattern[] = [
  {
    type: 'STUDENT_ID',
    description: 'PSD401 student numbers - 7 digits starting with 2 (e.g., 2240393)',
    // Matches: 2000000-2999999 (7 digits starting with 2). Word boundaries
    // prevent matching within larger numbers.
    //
    // The regex itself is NOT written here: it comes from
    // lib/safety/personal-data-patterns.json, the one place every runtime that
    // looks for a student number reads it from (#1886). This used to be a
    // third hand-maintained copy alongside chat-chart's and the broker's.
    //
    // Only the student number is shared with the public-link check's pattern
    // file. Its SSN, email and phone patterns are NOT added here because
    // Comprehend already detects those natively, with confidence scores.
    pattern: PSD_STUDENT_ID_PATTERN,
    confidence: 1.0,
  },
  // Add more district-specific patterns below:
  // {
  //   type: 'EMPLOYEE_ID',
  //   description: 'Employee badge numbers - E followed by 5 digits',
  //   pattern: /\bE\d{5}\b/i,
  //   confidence: 1.0,
  // },
];
