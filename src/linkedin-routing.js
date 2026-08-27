export function routingChoices(routing) {
  if (routing?.routes?.length) return routing.routes;
  return routing?.conversationId ? [routing] : [];
}

function toUnipileRoute(sendpilotRoute, conversation, recipientProviderId) {
  return {
    ...sendpilotRoute,
    source: "unipile_fallback",
    provider: "unipile",
    verified: true,
    fallbackEligible: false,
    fallbackFrom: "sendpilot_no_lead",
    fallbackReason: sendpilotRoute.reason || null,
    reason: undefined,
    campaignName: "Unipile fallback",
    sendpilotSenderId: sendpilotRoute.senderId,
    sendpilotConversationId: sendpilotRoute.conversationId,
    senderId: conversation.accountId,
    senderName: conversation.accountName,
    chatId: conversation.chatId,
    recipientProviderId,
    lastActivityAt: conversation.lastMessageAt,
    messages: conversation.messages,
  };
}

export async function addUnipileFallback(routing, person, unipile) {
  const choices = routingChoices(routing);
  if (!choices.some((choice) => choice.fallbackEligible && !choice.verified)) return routing;

  let result;
  try {
    result = await unipile.getConversations(person);
  } catch {
    // A secondary provider outage must not prevent the primary queue sync.
    return routing;
  }
  if (!result.recipientProviderId || !result.conversations.length) return routing;
  const bySenderName = new Map(result.conversations.map((conversation) => [conversation.accountName, conversation]));
  const enriched = choices.map((choice) => {
    if (!choice.fallbackEligible || choice.verified) return choice;
    const conversation = bySenderName.get(choice.senderName);
    return conversation ? toUnipileRoute(choice, conversation, result.recipientProviderId) : choice;
  });

  if (!routing?.routes?.length) return enriched[0] || routing;
  return { ...routing, routes: enriched };
}

export async function addUnipileFallbacks(people, routings, unipile) {
  return Promise.all(routings.map((routing, index) =>
    addUnipileFallback(routing, people[index], unipile)
  ));
}
