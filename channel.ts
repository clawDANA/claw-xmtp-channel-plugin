import type { Agent } from "@xmtp/agent-sdk";
import { monitorXmtp } from "./monitor.js";

// ── Global agent store for outbound (proactive) sends ──
const agents = new Map<string, Agent>();

export function registerAgent(accountId: string, agent: Agent) {
  agents.set(accountId, agent);
}

export function unregisterAgent(accountId: string) {
  agents.delete(accountId);
}

function getAgent(accountId?: string): Agent | undefined {
  if (accountId) return agents.get(accountId);
  return agents.values().next().value;
}

// ── Helpers ──

/** Check if a string looks like an Ethereum address */
function isEthAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** Check if a string looks like an XMTP conversation ID (hex or base64) */
function isConversationId(s: string): boolean {
  return /^[0-9a-fA-F]{32,}$/.test(s);
}

export const xmtpPlugin = {
  id: "xmtp",
  meta: {
    id: "xmtp",
    label: "XMTP",
    selectionLabel: "XMTP (Decentralized Messaging)",
    docsPath: "/channels/xmtp",
    blurb: "End-to-end encrypted decentralized messaging via XMTP protocol.",
    aliases: ["xmtp"],
  },
  capabilities: { chatTypes: ["direct", "group"] },

  messaging: {
    targetResolver: {
      hint: "Use an Ethereum address (0x...) for DMs, or a group conversation ID for groups.",
      // Tells OpenClaw to treat ETH addresses and conversation IDs as direct target IDs,
      // bypassing directory lookup
      looksLikeId: (trimmed: string) => {
        // ETH address
        if (/^0x[0-9a-fA-F]{40}$/i.test(trimmed)) return true;
        // group: prefix + conversation id
        if (/^group:[0-9a-fA-F]{32,}$/i.test(trimmed)) return true;
        return false;
      },
    },
  },

  config: {
    listAccountIds: (cfg: any) =>
      Object.keys(cfg.channels?.xmtp?.accounts ?? {}),
    resolveAccount: (cfg: any, accountId: string) =>
      cfg.channels?.xmtp?.accounts?.[accountId ?? "default"] ?? { accountId },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      const account = ctx.account;
      const log = ctx.log ?? console;

      return monitorXmtp({
        account,
        config: ctx.cfg,
        log,
        abortSignal: ctx.abortSignal,
      });
    },
  },

  outbound: {
    deliveryMode: "direct",

    // ── Target resolution ──
    // Accepts: 0x... (ETH address for DM), or conversationId (for group)
    resolveTarget: (params: any) => {
      const { to } = params;
      if (!to) return { ok: false, error: new Error("Missing target address") };

      // Strip optional "xmtp:" prefix
      const cleaned = to.replace(/^xmtp:/i, "");

      if (isEthAddress(cleaned)) {
        return { ok: true, to: cleaned.toLowerCase() };
      }

      if (isConversationId(cleaned)) {
        return { ok: true, to: `group:${cleaned}` };
      }

      // Pass through — might be a conversation ID or group reference
      return { ok: true, to: cleaned };
    },

    // ── Send media (stub — XMTP media support TBD) ──
    sendMedia: async (params: any) => {
      return { ok: false, error: "xmtp_media_not_supported" };
    },

    // ── Send text message ──
    sendText: async (params: any) => {
      const { to, text, accountId } = params;
      const agent = getAgent(accountId);

      if (!agent) {
        return { ok: false, error: "xmtp_agent_not_ready" };
      }

      try {
        // Group message: target starts with "group:"
        if (to.startsWith("group:")) {
          const convId = to.slice(6);
          const ctx = await agent.getConversationContext(convId);
          if (!ctx) {
            return { ok: false, error: `Group conversation ${convId} not found` };
          }
          await ctx.conversation.sendText(text);
          return { ok: true };
        }

        // DM: target is an Ethereum address
        const dm = await agent.createDmWithAddress(to as `0x${string}`);
        await dm.sendText(text);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err.message ?? "xmtp_send_failed" };
      }
    },
  },

  // ── Resolver adapter ──
  // Allows `message` tool to resolve XMTP targets by address
  resolver: {
    resolveTargets: async (params: any) => {
      const { inputs } = params;
      return (inputs ?? []).map((input: string) => {
        const cleaned = input.replace(/^xmtp:/i, "");
        if (isEthAddress(cleaned)) {
          return {
            input,
            resolved: true,
            id: cleaned.toLowerCase(),
            name: cleaned.toLowerCase(),
          };
        }
        // Conversation IDs
        if (isConversationId(cleaned)) {
          return {
            input,
            resolved: true,
            id: `group:${cleaned}`,
            name: `group:${cleaned.slice(0, 12)}…`,
          };
        }
        return { input, resolved: false, note: "Not a valid ETH address or conversation ID" };
      });
    },
  },
};
