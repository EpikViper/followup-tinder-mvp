import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
  const templates = await request.get("/api/templates");
  for (const template of (await templates.json()).templates) {
    await request.delete(`/api/templates/${template.id}`);
  }
});

test("rep completes the core follow-up workflow", async ({ page }) => {
  let lazyConversationRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/sendpilot/resolve")) lazyConversationRequests += 1;
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Oyster" })).toBeVisible();
  await expect(page.locator("#count")).toHaveText("01 / 01");
  await expect(page.getByText("THEY REPLIED")).not.toBeVisible();

  await page.getByRole("button", { name: "Templates" }).click();
  await page.getByRole("button", { name: "Add template" }).click();
  await page.locator("#template-name").fill("Quick context");
  await page.locator("#template-body").fill("Happy to send the short version here.");
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText("Quick context")).toBeVisible();
  await page.locator('[data-close="templates-dialog"]').click();

  await page.getByRole("button", { name: /Follow up on LinkedIn/ }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "SENDPILOT CAMPAIGN" })).toBeVisible();
  expect(lazyConversationRequests).toBe(0);
  await expect(page.locator('#sender-options [data-sender-id="5Oe83EFfTgS7GDIScVXrPg"]')).toHaveClass(/selected/);
  await page.locator("#composer-templates").click();
  await page.getByRole("button", { name: "Use" }).click();
  await expect(page.locator("#message-text")).toHaveValue("Happy to send the short version here.");
  await page.locator("#send-linkedin").click();
  await page.getByRole("button", { name: /Qualified/ }).click();
  await expect(page.getByRole("heading", { name: "Vanta" })).toBeVisible();

  await page.getByRole("button", { name: /Not qualified/ }).click();
  await page.locator("#confirm-not-qualified").click();
  await expect(page.getByRole("heading", { name: "Sana" })).toBeVisible();
  await expect(page.getByText("SENDPILOT · Sergi Cheishvili")).toBeVisible();

  await page.getByRole("button", { name: "Next company" }).click();
  await expect(page.getByRole("heading", { name: "Pigment" })).toBeVisible();
  await page.getByRole("button", { name: /^Lost/ }).click();
  await page.locator("#confirm-lost").click();
  await expect(page.getByRole("heading", { name: "Sana" })).toBeVisible();
});

test("forward and backward arrows navigate without completing cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Oyster" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous company" })).toBeDisabled();

  await page.getByRole("button", { name: "Next company" }).click();
  await expect(page.getByRole("heading", { name: "Vanta" })).toBeVisible();
  await expect(page.locator("#count")).toHaveText("01 / 04");

  await page.getByRole("button", { name: "Previous company" }).click();
  await expect(page.getByRole("heading", { name: "Oyster" })).toBeVisible();
  await expect(page.locator("#count")).toHaveText("01 / 04");
  await expect(page.getByRole("button", { name: "Previous company" })).toBeDisabled();
});

test("rep selector changes the owner-scoped queue", async ({ page }) => {
  await page.goto("/");
  await page.locator("#rep-select").selectOption({ label: "Sergi Cheishvili" });
  await expect(page.getByRole("heading", { name: "Airwallex" })).toBeVisible();
  await expect(page.locator("#count")).toHaveText("01 / 01");
});

test("multiple SendPilot conversations require an explicit sender choice", async ({ page }) => {
  await page.route("**/api/sync", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const maya = body.queue.flatMap((company) => company.contacts).find((contact) => contact.id === "person-maya");
    const sergi = {
      ...maya.sendpilot,
      senderId: "EmucfXukRDejlX7QvAw2GQ",
      senderName: "Sergi Cheishvili",
      lastActivityAt: "2026-08-13T15:52:44.720Z",
    };
    const revaz = {
      ...maya.sendpilot,
      verified: false,
      reason: "No sendable active SendPilot campaign match",
      senderId: "YcO4z477S8aHln4L-EIUGw",
      senderName: "Revaz Dzidziguri",
      lastActivityAt: "2026-08-10T07:56:53.300Z",
      messages: [{ id: "revaz-message", text: "Conversation through Revaz", timestamp: "2026-08-10T07:56:53.300Z", isSender: false }],
    };
    maya.sendpilot = { source: "sendpilot_campaign", verified: false, reason: "Choose a SendPilot sender conversation", routes: [sergi, revaz] };
    await route.fulfill({ response, json: body });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Follow up on LinkedIn/ }).click();
  await expect(page.locator("#sender-options .sender-option")).toHaveCount(2);
  await page.getByRole("button", { name: /Revaz Dzidziguri/ }).click();
  await expect(page.getByRole("button", { name: /Revaz Dzidziguri/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Conversation through Revaz")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy & open LinkedIn" })).toBeEnabled();
});

test("a verified Unipile fallback sends through the existing conversation", async ({ page }) => {
  await page.route("**/api/sync", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const index = body.queue.findIndex((company) => company.entryId === "entry-pigment");
    body.queue.unshift(...body.queue.splice(index, 1));
    await route.fulfill({ response, json: body });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pigment" })).toBeVisible();
  await expect(page.getByText(/UNIPILE FALLBACK/)).toBeVisible();
  await page.getByRole("button", { name: /Follow up on LinkedIn/ }).click();
  await expect(page.locator("#composer-source")).toContainText("UNIPILE FALLBACK");
  await expect(page.getByText("Send me the short version.")).toBeVisible();
  await page.locator("#message-text").fill("Here is the short version.");
  await page.getByRole("button", { name: "Send via Unipile" }).click();
  await expect(page.getByRole("heading", { name: "Oyster" })).toBeVisible();
});

test("email requires an explicit sender and sends a template as new mail", async ({ page, request }) => {
  await request.post("/api/templates", {
    data: { name: "Short email", body: "Happy to send the short version." },
  });

  await page.goto("/");
  await page.locator("#contact-select").selectOption("person-jules");
  await page.getByRole("button", { name: /Compose email/ }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "GMAIL · CHOOSE SENDER" })).toBeVisible();
  await expect(page.locator("#email-to")).toHaveValue("jules@oysterhr.com");
  await expect(page.locator("#email-sender-options .sender-option")).toHaveCount(3);
  await expect(page.locator("#send-email")).toBeDisabled();
  await page.locator("#email-templates").click();
  await page.getByRole("button", { name: "Use" }).click();
  await expect(page.locator("#email-message")).toHaveValue("Happy to send the short version.");
  await page.getByRole("button", { name: /Sergi Cheishvili.*sergi@stimuli.digital/ }).click();
  await expect(page.locator("#email-composer-source")).toHaveText("GMAIL · NEW EMAIL");
  await expect(page.locator("#send-email")).toBeDisabled();
  await page.locator("#email-subject").fill("Following up");
  await expect(page.locator("#send-email")).toBeEnabled();
  await page.locator("#send-email").click();
  await expect(page.getByRole("heading", { name: "Vanta" })).toBeVisible();
  await expect(page.locator("#email-dialog")).not.toBeVisible();
});

test("switching Gmail senders preserves the recipient and message and shows thread context", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Compose email/ }).click();
  await page.locator("#email-message").fill("Keeping this message while I compare mailboxes.");
  await page.getByRole("button", { name: /Sandro Truman/ }).click();
  await expect(page.locator("#email-composer-source")).toHaveText("GMAIL · REPLY");
  await expect(page.getByText("Yes, please send it over.")).toBeVisible();
  await expect(page.locator("#email-subject")).toHaveValue("Oyster follow-up");
  await expect(page.locator("#email-subject")).toHaveAttribute("readonly", "");

  await page.getByRole("button", { name: /Sergi Cheishvili.*sergi@stimuli.digital/ }).click();
  await expect(page.locator("#email-composer-source")).toHaveText("GMAIL · NEW EMAIL");
  await expect(page.locator("#email-to")).toHaveValue("maya@oysterhr.com");
  await expect(page.locator("#email-message")).toHaveValue("Keeping this message while I compare mailboxes.");
  await expect(page.locator("#email-subject")).toBeEditable();
});

test("failed Gmail delivery keeps the composer and card open without retrying", async ({ page }) => {
  let sendRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/email/send")) sendRequests += 1;
  });
  await page.goto("/");
  await page.locator("#contact-select").selectOption("person-jules");
  await page.getByRole("button", { name: /Compose email/ }).click();
  await page.getByRole("button", { name: /Sergi Cheishvili.*sergi@stimuli.digital/ }).click();
  await page.locator("#email-subject").fill("Failure test");
  await page.locator("#email-message").fill("MOCK_GMAIL_FAILURE");
  await page.locator("#send-email").click();
  await expect(page.locator("#email-dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Oyster" })).toBeVisible();
  await expect(page.locator("#email-message")).toHaveValue("MOCK_GMAIL_FAILURE");
  await expect(page.locator("#email-mode-note")).toContainText("Delivery failed");
  expect(sendRequests).toBe(1);
});

test("the focused card remains usable on a phone-sized viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Oyster" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Follow up on LinkedIn/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Compose email/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: /Compose email/ }).click();
  await expect(page.locator("#email-sender-options .sender-option")).toHaveCount(3);
  const dialogOverflow = await page.locator("#email-dialog").evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth);
  expect(dialogOverflow).toBeLessThanOrEqual(1);
  await page.locator('[data-close="email-dialog"]').click();
  await page.getByRole("button", { name: "Rules" }).click();
  await expect(page.getByRole("heading", { name: "Who appears here?" })).toBeVisible();
});
