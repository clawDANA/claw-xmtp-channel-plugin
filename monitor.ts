import { Agent, createUser, createSigner, filter } from "@xmtp/agent-sdk";
import { registerAgent, unregisterAgent } from "./channel.js";
import { getRuntime } from "./runtime.js";

export async function monitorXmtp(params: {
  account: any;
  config: any;
  log: any;
  abortSignal?: AbortSignal;
}) {
  const { account, config, abortSignal } = params;
  const log = params.log ?? console;
  const accountId = account.accountId;

  log.info?.(`[xmtp:${accountId}] Creating agent (env=${account.env ?? "production"})`);

  const user = createUser(account.walletKey);
  const signer = createSigner(user);

  const env = account.env ?? "production";
  const dbPath = account.dbPath
    ? (inboxId: string) => `${account.dbPath}/${env}-${inboxId.slice(0, 8)}.db3`
    : undefined;

  const dbEncKey = account.dbEncryptionKey
    ? Buffer.from(account.dbEncryptionKey.replace(/^0x/, ""), "hex")
    : undefined;

  const agent = await Agent.create(signer, {
    env: env as any,
    dbPath,
    dbEncryptionKey: dbEncKey,
    appVersion: "openclaw-xmtp/0.1.0",
  });

  log.info?.(`[xmtp:${accountId}] agent created | address=${agent.address} inboxId=${agent.client?.inboxId}`);

  // ── Shared message dispatcher ──
  const dispatch = async (ctx: any, text: string, extras: Record<string, any> = {}) => {
    const senderAddress = await ctx.getSenderAddress().catch(() => null);
    const from = senderAddress ?? ctx.message.senderInboxId;
    const convId = ctx.conversation.id;
    const isGroup = ctx.conversation.isGroup?.() ?? ("members" in ctx.conversation);
    const chatType = isGroup ? "group" : "direct";

    const sessionKey = isGroup
      ? `xmtp:${accountId}:group:${convId}`
      : `xmtp:${accountId}:${from}`;

    const conversationLabel = isGroup
      ? (ctx.conversation.name ?? `group:${convId.slice(0, 12)}`)
      : from;

    log.info?.(`[xmtp:${accountId}] in [${chatType}] from=${from} convId=${convId} text="${text.slice(0, 80)}"`);

    try {
      const rt = getRuntime();

      const ctxPayload = rt.channel.reply.finalizeInboundContext({
        Body: text,
        RawBody: text,
        From: from,
        To: agent.address,
        SessionKey: sessionKey,
        AccountId: accountId,
        ChatType: chatType,
        ConversationLabel: conversationLabel,
        SenderName: from,
        SenderId: from,
        Provider: "xmtp",
        Surface: "xmtp",
        OriginatingChannel: "xmtp",
        OriginatingTo: agent.address,
        // Group-specific metadata
        ...(isGroup ? { GroupId: convId, GroupName: ctx.conversation.name } : {}),
        // Reply-specific metadata
        ...extras,
      });

      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
          deliver: async (payload: any) => {
            const replyText: string = payload.text ?? "";
            if (!replyText) return;
            try {
              // If the incoming message was a reply, respond as a reply too
              if (extras.IsReply && ctx.sendTextReply) {
                await ctx.sendTextReply(replyText);
              } else {
                await ctx.conversation.sendText(replyText);
              }
              log.info?.(`[xmtp:${accountId}] out [${chatType}] convId=${convId} text="${replyText.slice(0, 80)}"`);
            } catch (err: any) {
              log.error?.(`[xmtp:${accountId}] deliver error: ${err.message ?? err}`);
            }
          },
          onError: (err: any) => {
            log.error?.(`[xmtp:${accountId}] dispatch error: ${err.message ?? err}`);
          },
        },
      });
    } catch (err: any) {
      log.error?.(`[xmtp:${accountId}] message handler error: ${err.message ?? err}`);
    }
  };

  // ── Handle plain text messages ──
  const handleTextMessage = async (ctx: any) => {
    if (filter.fromSelf(ctx.message, agent.client)) return;
    const text: string = String(ctx.message.content ?? "");
    if (!text) return;
    await dispatch(ctx, text);
  };

  // ── Handle reply messages (user replies to a message) ──
  const handleReplyMessage = async (ctx: any) => {
    if (filter.fromSelf(ctx.message, agent.client)) return;

    const replyContent = ctx.message.content;
    // Extract text: could be string directly or nested in .content
    let text: string;
    if (typeof replyContent?.content === "string") {
      text = replyContent.content;
    } else if (typeof replyContent?.content?.text === "string") {
      text = replyContent.content.text;
    } else {
      text = String(replyContent?.content ?? "");
    }

    if (!text) return;

    const referenceId: string | undefined = replyContent?.reference;
    log.info?.(`[xmtp:${accountId}] reply received, reference=${referenceId} text="${text.slice(0, 80)}"`);

    await dispatch(ctx, text, {
      IsReply: true,
      ReplyToMessageId: referenceId,
    });
  };

  // ── Register event handlers ──
  agent.on("text", handleTextMessage);
  agent.on("reply", handleReplyMessage);

  agent.on("group", (ctx: any) => {
    log.info?.(`[xmtp:${accountId}] joined group: ${ctx.conversation.id} name=${ctx.conversation.name ?? "(unnamed)"}`);
  });

  agent.on("unhandledError", (err: any) => {
    log.error?.(`[xmtp:${accountId}] unhandled error: ${err}`);
  });

  // ── Start agent ──
  // agent.start() is an infinite streaming loop — fire-and-forget,
  // then wait for the 'start' event to confirm readiness.
  const ready = new Promise<void>((resolve, reject) => {
    agent.on("start", () => {
      log.info?.(`[xmtp:${accountId}] ✅ ready | address=${agent.address}`);
      registerAgent(accountId, agent);
      // Sync all conversations (picks up new groups added after last start)
      agent.client?.conversations?.syncAllConversations?.()
        .then(() => log.info?.(`[xmtp:${accountId}] conversations synced`))
        .catch((e: any) => log.warn?.(`[xmtp:${accountId}] sync warn: ${e?.message}`));
      resolve();
    });
    agent.on("unhandledError", (err: any) => reject(err));
  });

  void agent.start().catch((err: any) => {
    log.error?.(`[xmtp:${accountId}] agent.start() crashed: ${err?.message ?? err}`);
  });

  await ready;

  const stop = async () => {
    log.info?.(`[xmtp:${accountId}] stopping`);
    await agent.stop().catch(() => { });
    unregisterAgent(accountId);
  };

  // Keep promise pending until abortSignal fires (OpenClaw requirement:
  // resolved startAccount() promise = crash → restart loop)
  await new Promise<void>((resolve) => {
    const onAbort = () => { void stop().then(resolve); };
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); return; }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    agent.on("stop", resolve);
  });

  return { stop };
}

