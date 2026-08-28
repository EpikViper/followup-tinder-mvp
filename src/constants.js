export const TIME_ZONE = "Asia/Tbilisi";
export const SYNC_INTERVAL_MS = 60 * 60_000;
export const OUTBOUND_LIST_ID = "7ac0b11c-204e-4c25-a744-e306606f6aa4";

export const REPS = [
  {
    id: "d9d9526a-9718-4861-a3b4-cc7e47f2b596",
    name: "Sandro Truman",
  },
  {
    id: "5daf99ac-0118-48c8-aad0-06ed2ac707b3",
    name: "Sergi Cheishvili",
  },
];

// Email sender choice is deliberately independent of Attio queue ownership.
// IDs are the exact delegated Gmail mailboxes so the server never has to map a
// browser-supplied alias to a more privileged account.
export const EMAIL_SENDERS = [
  { id: "sandro@stimuli.digital", name: "Sandro Truman", email: "sandro@stimuli.digital" },
  { id: "sergi@stimuli.digital", name: "Sergi Cheishvili", email: "sergi@stimuli.digital" },
  { id: "sergi@revcode.app", name: "Sergi Cheishvili", email: "sergi@revcode.app" },
];

// Sender identity is deliberately independent of Attio ownership.
export const LINKEDIN_SENDERS = [
  {
    id: "5Oe83EFfTgS7GDIScVXrPg",
    name: "Sandro Turmanidze",
  },
  {
    id: "EmucfXukRDejlX7QvAw2GQ",
    name: "Sergi Cheishvili",
  },
  {
    id: "YcO4z477S8aHln4L-EIUGw",
    name: "Revaz Dzidziguri",
  },
];

export const INTERACTION_OPTION_IDS = {
  Us: "e49570ae-01ef-4cf5-8f26-9bc3c18ce9d5",
  Them: "4d8ba426-f284-469a-a53e-ed98ad6cf516",
};

export const PRE_DEMO_COUNTER_STAGES = new Set([
  "Unprocessed",
  "Qualified",
]);

export const QUEUE_LABELS = {
  unprocessed: "UNPROCESSED",
  inbound: "THEY REPLIED",
  no_show: "NO SHOW",
  follow_up: "FOLLOW-UP DUE",
};
