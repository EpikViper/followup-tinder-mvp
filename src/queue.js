import { TIME_ZONE } from "./constants.js";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function dateInTbilisi(value = new Date()) {
  const parts = dateFormatter.formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseDateOnly(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function relativeDateCutoff(now = new Date(), days = 2) {
  const today = parseDateOnly(dateInTbilisi(now));
  today.setUTCDate(today.getUTCDate() - days);
  return today;
}

export function isFollowUpDue(lastInteractionDate, now = new Date()) {
  const interactionDate = parseDateOnly(lastInteractionDate);
  if (!interactionDate) return false;
  return interactionDate < relativeDateCutoff(now);
}

export function classifyCompany(company, now = new Date()) {
  const stage = company.stage || "Unprocessed";
  if (stage === "Unprocessed") {
    return { queueType: "unprocessed", priority: 0 };
  }
  if (stage === "Qualified" && company.lastInteractionBy === "Them") {
    return { queueType: "inbound", priority: 1 };
  }
  if (
    stage === "Meeting Booked" &&
    company.meetingStatus === "No show" &&
    isFollowUpDue(company.lastInteractionDate, now)
  ) {
    return { queueType: "no_show", priority: 2 };
  }
  if (
    stage === "Qualified" &&
    company.lastInteractionBy !== "Them" &&
    isFollowUpDue(company.lastInteractionDate, now)
  ) {
    return { queueType: "follow_up", priority: 3 };
  }
  return null;
}

export function buildQueue(companies, now = new Date()) {
  return companies
    .map((company) => {
      const bucket = classifyCompany(company, now);
      return bucket ? { ...company, ...bucket } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aDate = a.lastInteractionDate || a.addedAt || "9999-12-31";
      const bDate = b.lastInteractionDate || b.addedAt || "9999-12-31";
      return aDate.localeCompare(bDate) || a.companyName.localeCompare(b.companyName);
    });
}
