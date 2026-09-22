/**
 * Rule-shape test for the ALB WebACL's handling of the Nexus chat body.
 *
 * `POST /api/nexus/chat` re-sends the whole conversation on every turn, and a
 * prior assistant turn can legitimately carry raw HTML (Gemini's Google Search
 * grounding returns `search_suggestions: "<style>…"` inside tool results). On
 * 2026-09-22 the Core rule set's `CrossSiteScripting_BODY` blocked every
 * follow-up in such a conversation with a bare 403 that never reached the app.
 *
 * The fix runs the Core rule set twice, each copy scoped to a disjoint set of
 * paths: the general copy on everything except the chat endpoint, and a
 * chat-scoped copy with the body XSS rule in COUNT mode. These assertions lock
 * in that split so a later "cleanup" cannot silently re-enable the block or
 * widen the COUNT override beyond the chat path.
 */
import type * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { buildWebAclRules, NEXUS_CHAT_PATH } from '../lib/frontend-stack-ecs';

type Rule = wafv2.CfnWebACL.RuleProperty;
type Statement = wafv2.CfnWebACL.StatementProperty;
type ManagedGroup = wafv2.CfnWebACL.ManagedRuleGroupStatementProperty;
type Override = wafv2.CfnWebACL.RuleActionOverrideProperty;
type ExcludedRule = wafv2.CfnWebACL.ExcludedRuleProperty;

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

const nexusChatPathMatch: Statement = {
  byteMatchStatement: {
    fieldToMatch: { uriPath: {} },
    positionalConstraint: 'STARTS_WITH',
    searchString: NEXUS_CHAT_PATH,
    textTransformations: [{ priority: 0, type: 'NONE' }],
  },
};

describe('ALB WAF rules for the Nexus chat body', () => {
  it('targets the Nexus chat endpoint', () => {
    expect(NEXUS_CHAT_PATH).toBe('/api/nexus/chat');
  });

  it('gives every rule a unique priority', () => {
    const priorities = rules.map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('keeps the general Core rule set off the Nexus chat path', () => {
    const group = managedGroup(ruleNamed('AWSManagedRulesCommonRuleSet'));
    expect(group.name).toBe('AWSManagedRulesCommonRuleSet');
    expect(group.scopeDownStatement).toEqual({
      notStatement: { statement: nexusChatPathMatch },
    });
    // The two long-standing exclusions are unchanged.
    expect(group.excludedRules as ExcludedRule[]).toEqual([
      { name: 'SizeRestrictions_BODY' },
      { name: 'GenericRFI_BODY' },
    ]);
    expect(group.ruleActionOverrides).toBeUndefined();
  });

  it('runs the Core rule set on the Nexus chat path with only the body XSS rule (plus the two long-standing exclusions) in COUNT mode', () => {
    const rule = ruleNamed('AWSManagedRulesCommonRuleSetNexusChat');
    const group = managedGroup(rule);
    expect(group.name).toBe('AWSManagedRulesCommonRuleSet');
    expect(group.scopeDownStatement).toEqual(nexusChatPathMatch);

    const overrides = group.ruleActionOverrides as Override[];
    expect(overrides.map((o) => o.name).sort()).toEqual([
      'CrossSiteScripting_BODY',
      'GenericRFI_BODY',
      'SizeRestrictions_BODY',
    ]);
    for (const override of overrides) {
      expect(override.actionToUse).toEqual({ count: {} });
    }
    // Overrides replace the deprecated excludedRules on this copy; never both.
    expect(group.excludedRules).toBeUndefined();
    // The rule group itself still blocks: only the listed rules are counted.
    expect(rule.overrideAction).toEqual({ none: {} });
    const visibility = rule.visibilityConfig as wafv2.CfnWebACL.VisibilityConfigProperty;
    expect(visibility.metricName).toBe('CommonRuleSetNexusChat');
  });

  it('leaves the KnownBadInputs and SQLi rule groups unscoped and unmodified', () => {
    for (const name of ['AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesSQLiRuleSet']) {
      const group = managedGroup(ruleNamed(name));
      expect(group.name).toBe(name);
      expect(group.scopeDownStatement).toBeUndefined();
      expect(group.ruleActionOverrides).toBeUndefined();
      expect(group.excludedRules).toBeUndefined();
    }
  });

  it('keeps the browser rate limit scoped off /api/agent/', () => {
    const statement = ruleNamed('RateLimitRule').statement as Statement;
    const rate = statement.rateBasedStatement as wafv2.CfnWebACL.RateBasedStatementProperty;
    expect(rate.limit).toBe(2000);
    expect(rate.scopeDownStatement).toEqual({
      notStatement: {
        statement: {
          byteMatchStatement: {
            fieldToMatch: { uriPath: {} },
            positionalConstraint: 'STARTS_WITH',
            searchString: '/api/agent/',
            textTransformations: [{ priority: 0, type: 'NONE' }],
          },
        },
      },
    });
  });
});
