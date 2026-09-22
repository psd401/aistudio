/**
 * Rule-shape test for how the ALB WebACL treats the body-inspection
 * signatures of the three AWS managed rule groups.
 *
 * `POST /api/nexus/chat` re-sends the whole conversation on every turn, and a
 * prior assistant turn can legitimately carry raw HTML (Gemini's Google Search
 * grounding returns `search_suggestions: "<style>…"` inside tool results);
 * `/api/agent/*` carries the agent runtime's proxy-signed server-to-server
 * bodies. On 2026-09-22 `CrossSiteScripting_BODY` blocked every follow-up in
 * such a Nexus conversation and `SQLi_BODY` blocked the runtime's credential
 * fetch, each with a bare 403 that never reached the app.
 *
 * The fix is the AWS label pattern: every body rule in the managed groups is
 * overridden to COUNT (it still adds its label and keeps its metric), and one
 * custom rule after the groups BLOCKS on those labels for every path that is
 * not an AI body path. These assertions pin the exact rule names and label
 * strings (taken from `aws wafv2 describe-managed-rule-group` on 2026-09-22),
 * because a typo in either silently turns a signature off everywhere.
 */
import type * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import {
  AGENT_API_PREFIX,
  AI_BODY_PATH_PREFIXES,
  ALWAYS_COUNTED_CORE_RULES,
  BODY_SIGNATURE_RULES,
  NEXUS_CHAT_PREFIX,
  WAF_LOG_REDACTED_HEADERS,
  bodySignatureLabels,
  buildWebAclRules,
} from '../lib/frontend-stack-ecs';

type Rule = wafv2.CfnWebACL.RuleProperty;
type Statement = wafv2.CfnWebACL.StatementProperty;
type ManagedGroup = wafv2.CfnWebACL.ManagedRuleGroupStatementProperty;
type Override = wafv2.CfnWebACL.RuleActionOverrideProperty;
type LabelMatch = wafv2.CfnWebACL.LabelMatchStatementProperty;

const rules = buildWebAclRules();

function ruleNamed(name: string): Rule {
  const rule = rules.find((r) => r.name === name);
  if (!rule) throw new Error(`WAF rule ${name} not found`);
  return rule;
}

function managedGroup(rule: Rule): ManagedGroup {
  const statement = rule.statement as Statement;
  const group = statement.managedRuleGroupStatement as ManagedGroup | undefined;
  if (!group) throw new Error(`WAF rule ${rule.name} is not a managed rule group`);
  return group;
}

function pathPrefixMatch(prefix: string): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH',
      searchString: prefix,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  };
}

// Every `_BODY` rule each group ships, per `describe-managed-rule-group`
// (REGIONAL, 2026-09-22). If AWS adds one, this list and BODY_SIGNATURE_RULES
// must both grow, or the new signature blocks AI bodies again.
const MANAGED_BODY_RULES: Record<string, string[]> = {
  AWSManagedRulesCommonRuleSet: [
    'SizeRestrictions_BODY',
    'EC2MetaDataSSRF_BODY',
    'GenericLFI_BODY',
    'GenericRFI_BODY',
    'CrossSiteScripting_BODY',
  ],
  AWSManagedRulesKnownBadInputsRuleSet: [
    'JavaDeserializationRCE_BODY',
    'Log4JRCE_BODY',
    'ReactJSRCE_BODY',
  ],
  AWSManagedRulesSQLiRuleSet: ['SQLi_BODY'],
};

// The labels those rules add, verbatim from the same API call.
const EXPECTED_BLOCK_LABELS = [
  'awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body',
  'awswaf:managed:aws:core-rule-set:GenericLFI_Body',
  'awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_Body',
  'awswaf:managed:aws:known-bad-inputs:JavaDeserializationRCE_Body',
  'awswaf:managed:aws:known-bad-inputs:Log4JRCE_Body',
  'awswaf:managed:aws:known-bad-inputs:ReactJSRCE_Body',
  'awswaf:managed:aws:sql-database:SQLi_Body',
];

const MANAGED_GROUP_NAMES = Object.keys(MANAGED_BODY_RULES);

describe('ALB WAF body signatures on AI paths', () => {
  it('names the two AI body paths', () => {
    expect(NEXUS_CHAT_PREFIX).toBe('/api/nexus/chat');
    expect(AGENT_API_PREFIX).toBe('/api/agent/');
    expect([...AI_BODY_PATH_PREFIXES]).toEqual(['/api/nexus/chat', '/api/agent/']);
  });

  it('gives every rule a unique priority', () => {
    const priorities = rules.map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it.each(MANAGED_GROUP_NAMES)('%s runs once, unscoped, with every body rule in COUNT mode', (name) => {
    const rule = ruleNamed(name);
    const group = managedGroup(rule);
    expect(group.name).toBe(name);
    expect(group.scopeDownStatement).toBeUndefined();
    // Overrides replace the deprecated excludedRules; never both.
    expect(group.excludedRules).toBeUndefined();
    // The group itself still blocks: only the listed rules are counted.
    expect(rule.overrideAction).toEqual({ none: {} });

    const overrides = group.ruleActionOverrides as Override[];
    for (const override of overrides) {
      expect(override.actionToUse).toEqual({ count: {} });
    }
    expect([...overrides.map((o) => o.name)].sort()).toEqual(
      [...MANAGED_BODY_RULES[name]].sort()
    );
  });

  it('keeps only the two long-standing Core exclusions count-only without re-blocking them', () => {
    expect([...ALWAYS_COUNTED_CORE_RULES]).toEqual(['SizeRestrictions_BODY', 'GenericRFI_BODY']);
    const labels = bodySignatureLabels();
    expect(labels).not.toContain('awswaf:managed:aws:core-rule-set:SizeRestrictions_Body');
    expect(labels).not.toContain('awswaf:managed:aws:core-rule-set:GenericRFI_Body');
  });

  it('derives exactly the labels AWS publishes for the counted body rules', () => {
    expect(bodySignatureLabels()).toEqual(EXPECTED_BLOCK_LABELS);
    // Every counted-but-re-blocked rule has a label, and nothing else does.
    const reblocked = Object.values(BODY_SIGNATURE_RULES).flatMap((g) => [...g.rules]);
    expect(reblocked).toHaveLength(EXPECTED_BLOCK_LABELS.length);
  });

  it('re-blocks the counted signatures everywhere except the AI body paths, after the managed groups', () => {
    const rule = ruleNamed('BodySignaturesBlock');
    expect(rule.action).toEqual({ block: {} });
    for (const name of MANAGED_GROUP_NAMES) {
      expect(rule.priority).toBeGreaterThan(ruleNamed(name).priority);
    }

    const statement = rule.statement as Statement;
    const and = statement.andStatement as wafv2.CfnWebACL.AndStatementProperty;
    const [labelsOr, pathsNot] = and.statements as Statement[];

    const labelStatements = (labelsOr.orStatement as wafv2.CfnWebACL.OrStatementProperty)
      .statements as Statement[];
    const labelMatches = labelStatements.map((s) => s.labelMatchStatement as LabelMatch);
    expect(labelMatches.map((m) => m.scope)).toEqual(EXPECTED_BLOCK_LABELS.map(() => 'LABEL'));
    expect(labelMatches.map((m) => m.key)).toEqual(EXPECTED_BLOCK_LABELS);

    expect(pathsNot).toEqual({
      notStatement: {
        statement: {
          orStatement: {
            statements: [pathPrefixMatch('/api/nexus/chat'), pathPrefixMatch('/api/agent/')],
          },
        },
      },
    });

    const visibility = rule.visibilityConfig as wafv2.CfnWebACL.VisibilityConfigProperty;
    expect(visibility.metricName).toBe('BodySignaturesBlock');
    expect(visibility.cloudWatchMetricsEnabled).toBe(true);
  });

  it('redacts every credential-bearing header from the WAF log', () => {
    // Session/API-key bearer tokens, the proxy-signed agent invocation
    // context + proof set (lib/agent-workspace/invocation-context.ts), the
    // Drive push-channel secret, and the MCP session handle. Header names
    // must be lowercase for WAF's SingleHeader match.
    const required = [
      'authorization',
      'cookie',
      'x-agent-invocation-context',
      'x-agent-request-proof-signature',
      'x-agent-request-proof-nonce',
      'x-goog-channel-token',
      'mcp-session-id',
    ];
    for (const header of required) {
      expect(WAF_LOG_REDACTED_HEADERS).toContain(header);
    }
    for (const header of WAF_LOG_REDACTED_HEADERS) {
      expect(header).toBe(header.toLowerCase());
    }
  });

  it('keeps the browser rate limit scoped off /api/agent/', () => {
    const statement = ruleNamed('RateLimitRule').statement as Statement;
    const rate = statement.rateBasedStatement as wafv2.CfnWebACL.RateBasedStatementProperty;
    expect(rate.limit).toBe(2000);
    expect(rate.scopeDownStatement).toEqual({
      notStatement: { statement: pathPrefixMatch('/api/agent/') },
    });
  });
});
