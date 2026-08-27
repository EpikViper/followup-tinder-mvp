export function canonicalLinkedinUrl(value) {
  if (!value) return null;
  try {
    const raw = String(value).trim();
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withScheme.replace(/^http:\/\//i, "https://"));
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/in\/([^/?#]+)/i);
    return match ? `https://www.linkedin.com/in/${decodeURIComponent(match[1]).toLowerCase()}` : null;
  } catch {
    return null;
  }
}

export function normalizePersonName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function looksLikeLinkedinOpaqueId(slug) {
  return /^aco[a-z0-9_-]{16,}$/i.test(slug);
}

function looksLikeGeneratedSuffix(token) {
  if (token.length < 6) return false;
  const digits = [...token].filter((character) => /\d/.test(character)).length;
  return digits >= Math.ceil(token.length / 2);
}

export function linkedinSlugName(value) {
  const canonical = canonicalLinkedinUrl(value);
  if (!canonical) return null;
  const slug = canonical.slice(canonical.lastIndexOf("/") + 1);
  if (!slug || looksLikeLinkedinOpaqueId(slug)) return null;

  const tokens = slug.split(/[-_]+/).filter(Boolean);
  if (tokens.length && looksLikeGeneratedSuffix(tokens.at(-1))) tokens.pop();
  if (tokens.length) {
    tokens[tokens.length - 1] = tokens.at(-1).replace(/^(\p{L}{2,})\d{1,3}$/u, "$1");
  }
  const name = normalizePersonName(tokens.join(" "));
  const nameTokens = name.split(" ").filter(Boolean);
  if (nameTokens.length < 2 || nameTokens.slice(1).every((token) => token.length === 1)) return null;
  return name;
}

function uniqueConversations(conversations) {
  const seen = new Set();
  return conversations.filter((conversation) => {
    const key = `${conversation.accountId}:${conversation.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findConversationCandidates({ person, leads, conversationIndex, linkedinLeadMatched }) {
  const linkedinUrl = canonicalLinkedinUrl(person?.linkedinUrl);
  const direct = linkedinUrl ? uniqueConversations(conversationIndex.byUrl.get(linkedinUrl) || []) : [];
  if (direct.length) {
    return {
      conversations: direct,
      evidence: { strategy: "linkedin_url", confidence: "exact", value: linkedinUrl },
    };
  }

  const aliases = new Map();
  const addAlias = (value, strategy, confidence) => {
    const key = normalizePersonName(value);
    if (key && !aliases.has(key)) aliases.set(key, { key, strategy, confidence });
  };

  // A public LinkedIn slug is especially valuable when SendPilot returns an
  // opaque /in/ACo... participant URL and Attio stores an abbreviated name.
  addAlias(linkedinSlugName(person?.linkedinUrl), "linkedin_slug", linkedinLeadMatched ? "corroborated" : "derived");
  for (const lead of leads) {
    addAlias(linkedinSlugName(lead.linkedinUrl), "lead_linkedin_slug", linkedinLeadMatched ? "corroborated" : "derived");
    addAlias(lead.name || `${lead.firstName || ""} ${lead.lastName || ""}`, "lead_name", linkedinLeadMatched ? "corroborated" : "exact");
  }
  addAlias(person?.name, "contact_name", "exact");

  for (const alias of aliases.values()) {
    const matches = uniqueConversations(conversationIndex.byName.get(alias.key) || []);
    if (matches.length) return { conversations: matches, evidence: { ...alias, value: alias.key } };
  }
  return { conversations: [], evidence: null };
}
