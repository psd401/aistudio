/**
 * Post an escalation card to a user's Chat DM.
 *
 * Mirrors the message shape the cron Lambda uses (`sendChatMessage`)
 * including the rich-output envelope handling, so the user gets a
 * proper card rather than plain text.
 *
 * The Chat API client uses the SAME Google credentials secret as the
 * cron Lambda — service-account JWT, scope `chat.bot`.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import * as chatPkg from "@googleapis/chat";

import type { GmailMessageMeta, Suggestion } from "./types";
import type { Label } from "./rules";

const GOOGLE_CREDENTIALS_SECRET_ARN =
  process.env.GOOGLE_CREDENTIALS_SECRET_ARN ?? "";

let cachedSecret: { json: string; fetchedAt: number } | null = null;
let cachedClient: ReturnType<typeof chatPkg.chat> | null = null;

async function getCredentials(): Promise<Record<string, unknown>> {
  // 10-minute cache, matches the cron Lambda's TTL.
  if (cachedSecret && Date.now() - cachedSecret.fetchedAt < 10 * 60_000) {
    return JSON.parse(cachedSecret.json);
  }
  const sm = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
  const resp = await sm.send(
    new GetSecretValueCommand({ SecretId: GOOGLE_CREDENTIALS_SECRET_ARN }),
  );
  if (!resp.SecretString) {
    throw new Error("Google credentials secret has no SecretString");
  }
  cachedSecret = { json: resp.SecretString, fetchedAt: Date.now() };
  cachedClient = null; // force re-init with fresh creds
  return JSON.parse(resp.SecretString);
}

async function getChatClient(): Promise<ReturnType<typeof chatPkg.chat>> {
  if (cachedClient) return cachedClient;
  const credentials = await getCredentials();
  const googleAuth = new chatPkg.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
  });
  cachedClient = chatPkg.chat({ version: "v1", auth: googleAuth });
  return cachedClient;
}

/**
 * Find the bot's DM space with a given user, identified by the
 * Google Chat user resource name (`users/<id>`). The bot's Chat client
 * lists all spaces it's a member of and matches by HUMAN member name.
 *
 * O(spaces × members-in-each-space) — cheap because the bot only has
 * DM spaces with users who've messaged it (typically <100). Match-on-
 * first means most lookups exit early.
 *
 * Mirrors the cron Lambda's `resolveDmSpace`. Returns null if no DM
 * found, which the caller surfaces as "user hasn't DM'd the bot yet."
 */
export async function resolveDmSpace(googleIdentity: string): Promise<string | null> {
  try {
    const client = await getChatClient();
    let pageToken: string | undefined;
    let scanned = 0;
    do {
      const resp = await client.spaces.list({ pageToken, pageSize: 100 });
      const spaces = resp.data.spaces || [];
      scanned += spaces.length;
      for (const space of spaces) {
        if (!space.name || !space.singleUserBotDm) continue;
        const membersResp = await client.spaces.members.list({
          parent: space.name,
          pageSize: 10,
        });
        for (const m of membersResp.data.memberships || []) {
          if (m.member?.type === "HUMAN" && m.member?.name === googleIdentity) {
            return space.name;
          }
        }
      }
      pageToken = resp.data.nextPageToken || undefined;
    } while (pageToken);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      level: "WARN", logger: "triage-poll", evt: "dm_space_not_found",
      googleIdentity, spacesScanned: scanned,
    }));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      level: "ERROR", logger: "triage-poll", evt: "dm_space_resolve_error",
      googleIdentity,
      err: error instanceof Error ? error.message : String(error),
    }));
  }
  return null;
}

export interface EscalationParams {
  dmSpaceName: string;
  userEmail: string;
  label: Label;
  message: GmailMessageMeta;
  reason: string;
}

/**
 * Post a card escalation to the user's DM. Card shows:
 *   header: "📬 Triage flagged"
 *   key/value rows for label, sender, subject
 *   text paragraph with snippet
 *   button: "Open in Gmail"
 */
export async function postEscalation(params: EscalationParams): Promise<void> {
  const client = await getChatClient();

  const labelDisplay =
    params.label === "important"
      ? "Important"
      : params.label === "later"
        ? "Later"
        : "News";

  const cardsV2 = [
    {
      cardId: `triage-${params.message.id}`,
      card: {
        header: {
          title: "📬 Triage flagged a message",
          subtitle: `${labelDisplay} · ${params.reason}`,
        },
        sections: [
          {
            widgets: [
              {
                decoratedText: {
                  topLabel: "From",
                  text: params.message.fromEmail,
                },
              },
              {
                decoratedText: {
                  topLabel: "Subject",
                  text: params.message.subject || "(no subject)",
                },
              },
              ...(params.message.snippet
                ? [{ textParagraph: { text: truncate(params.message.snippet, 400) } }]
                : []),
              {
                buttonList: {
                  buttons: [
                    {
                      text: "Open in Gmail",
                      onClick: {
                        openLink: {
                          url: `https://mail.google.com/mail/u/0/#inbox/${params.message.id}`,
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  ];

  // cardsV2 isn't in the @googleapis/chat 5.0 type schema yet (it
  // accepts the field, just not in TS types). Cast through unknown for
  // the same reason the cron Lambda does.
  const requestBody: Record<string, unknown> = {
    text: `Triage flagged: ${params.message.subject || params.message.fromEmail}`,
    cardsV2,
  };
  await client.spaces.messages.create({
    parent: params.dmSpaceName,
    requestBody,
  });
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export interface SuggestionCardParams {
  dmSpaceName: string;
  suggestions: Suggestion[];
}

/**
 * Post a card summarising NEW pending rule suggestions from the nightly
 * learning job (#1172). Hard rules are suggest-only: the card tells the
 * user how to approve ("apply the rule") — approval itself flows through
 * the skill's `suggestions apply <id>` subcommand, which the agent runs
 * on the user's say-so. We deliberately don't embed interactive buttons
 * (they'd need a Chat webhook round-trip); the agent is the action layer.
 */
export async function postSuggestionCard(
  params: SuggestionCardParams,
): Promise<void> {
  if (params.suggestions.length === 0) return;
  const client = await getChatClient();

  const widgets = params.suggestions.slice(0, 10).map((s) => ({
    decoratedText: {
      topLabel: s.kind === "mute" ? "Mute suggestion" : "VIP suggestion",
      text: truncate(s.reason, 300),
      bottomLabel: `id: ${s.id}`,
    },
  }));

  const card = {
    cardId: `triage-suggestions-${Date.now()}`,
    card: {
      header: {
        title: "💡 Triage learned something",
        subtitle: `${params.suggestions.length} suggested rule change(s) from your recent corrections`,
      },
      sections: [
        { widgets },
        {
          widgets: [
            {
              textParagraph: {
                text:
                  "Tell me to <b>apply</b> or <b>dismiss</b> any of these (e.g. " +
                  '"apply the first one" or "ignore that") and I\'ll update your ' +
                  "triage rules. Nothing changes until you approve.",
              },
            },
          ],
        },
      ],
    },
  };

  const requestBody: Record<string, unknown> = {
    text: `💡 Triage has ${params.suggestions.length} suggested rule change(s) from your recent corrections.`,
    cardsV2: [card],
  };
  await client.spaces.messages.create({
    parent: params.dmSpaceName,
    requestBody,
  });
}

export interface TaskOutcomeParams {
  dmSpaceName: string;
  subject: string;
  fromEmail: string;
  messageId: string;
  ok: boolean;
  taskRef?: string;
  reason?: string;
}

/**
 * Post a one-line outcome card to the user's DM when a @psd/Task
 * gesture finishes — either with the success ref or with the failure
 * reason. Used by Phase 1.5 of the email triage feature.
 *
 * Success cards only fire when the user has `tasksNotifySuccess=true`
 * on their triage row; failure cards always fire so the user knows
 * their gesture didn't take effect.
 */
export async function postTaskOutcome(params: TaskOutcomeParams): Promise<void> {
  const client = await getChatClient();
  const card = params.ok
    ? {
        cardId: `triage-task-ok-${params.messageId}`,
        card: {
          header: {
            title: "✓ Tasked",
            subtitle: `${params.taskRef ?? "task created"} · ${params.fromEmail}`,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: truncate(params.subject || "(no subject)", 200),
                  },
                },
              ],
            },
          ],
        },
      }
    : {
        cardId: `triage-task-fail-${params.messageId}`,
        card: {
          header: {
            title: "⚠️ Task creation failed",
            subtitle: params.fromEmail,
          },
          sections: [
            {
              widgets: [
                {
                  decoratedText: {
                    topLabel: "Subject",
                    text: truncate(params.subject || "(no subject)", 200),
                  },
                },
                {
                  decoratedText: {
                    topLabel: "Reason",
                    text: truncate(params.reason ?? "unknown", 400),
                  },
                },
                {
                  textParagraph: {
                    text:
                      "The email is still in your @psd/Task label. To retry, " +
                      "remove the label and re-apply it — the next 5-minute " +
                      "tick will pick it up.",
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Open in Gmail",
                        onClick: {
                          openLink: {
                            url: `https://mail.google.com/mail/u/0/#all/${params.messageId}`,
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

  const requestBody: Record<string, unknown> = {
    text: params.ok
      ? `✓ Tasked: ${params.subject || params.fromEmail}${params.taskRef ? ` → ${params.taskRef}` : ""}`
      : `⚠️ Task creation failed for ${params.subject || params.fromEmail}: ${params.reason ?? "unknown"}`,
    cardsV2: [card],
  };
  await client.spaces.messages.create({
    parent: params.dmSpaceName,
    requestBody,
  });
}
