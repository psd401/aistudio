/**
 * Bedrock system-defined guardrail-profile IAM helpers.
 *
 * When a guardrail is applied through a cross-region inference PROFILE
 * (guardrails-stack.ts `crossRegionConfig`), `bedrock:ApplyGuardrail`
 * authorizes against BOTH the guardrail ARN AND the guardrail-PROFILE ARN
 * of the *destination* region the request is routed to — not the caller's
 * region. Granting the profile ARN in only one region therefore yields
 * `AccessDenied` on every call that Bedrock happens to route to a different
 * region (2026-07-06 dev outage: 100% of router turns denied on
 * us-east-2 while the grant covered us-east-1 only).
 *
 * The AWS system-defined US guardrail profile `us.guardrail.v1:0` fans out
 * across a FIXED set of US regions, independent of the stack's deploy
 * region. The grant must cover that whole set. The profile ID stays pinned
 * (NOT a wildcard) so the grant remains scoped to exactly this profile.
 *
 * See PR #1093 (first partial fix) and issue #1138 F5 (this completion).
 */

/**
 * Regions the AWS system-defined US guardrail profile (`us.guardrail.v1:0`)
 * routes inference across. Fixed by AWS, not derived from the stack region.
 * https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-cross-region-support.html
 */
export const US_GUARDRAIL_PROFILE_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
] as const;

/** The system-defined US guardrail profile identifier. */
export const US_GUARDRAIL_PROFILE_ID = 'us.guardrail.v1:0';

/**
 * IAM resource ARNs for the US guardrail profile in every region it can be
 * routed to. Use these alongside the guardrail ARN in any
 * `bedrock:ApplyGuardrail` / `bedrock:GetGuardrail` policy statement.
 *
 * @param account - the AWS account id the profile resolves in (the caller's
 *   account; the profile ARN is region-scoped but account-owned).
 */
export function usGuardrailProfileArns(account: string): string[] {
  return US_GUARDRAIL_PROFILE_REGIONS.map(
    (region) =>
      `arn:aws:bedrock:${region}:${account}:guardrail-profile/${US_GUARDRAIL_PROFILE_ID}`
  );
}
