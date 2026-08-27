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
  await expect(page.locator("#count")).toHaveText("01 / 04");
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

test("email opens a prefilled Gmail draft and can use a saved template", async ({ page, request, context }) => {
  await request.post("/api/templates", {
    data: { name: "Short email", body: "Happy to send the short version." },
  });
  await context.route("https://mail.google.com/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<title>Gmail draft</title>" });
  });

  await page.goto("/");
  await page.locator("#contact-select").selectOption("person-jules");
  await page.getByRole("button", { name: /Compose email/ }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "GMAIL COMPOSER" })).toBeVisible();
  await expect(page.locator("#email-to")).toHaveValue("jules@oysterhr.com");
  await page.locator("#email-subject").fill("Following up");
  await page.locator("#email-templates").click();
  await page.getByRole("button", { name: "Use" }).click();
  await expect(page.locator("#email-message")).toHaveValue("Happy to send the short version.");

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open in Gmail" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  const draftUrl = new URL(popup.url());
  expect(draftUrl.hostname).toBe("mail.google.com");
  expect(draftUrl.searchParams.get("to")).toBe("jules@oysterhr.com");
  expect(draftUrl.searchParams.get("su")).toBe("Following up");
  expect(draftUrl.searchParams.get("body")).toBe("Happy to send the short version.");
  await expect(page.getByRole("heading", { name: "Oyster" })).toBeVisible();
});

test("email opens the existing Gmail thread instead of a new draft", async ({ page, context }) => {
  await context.route("https://mail.google.com/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<title>Existing Gmail thread</title>" });
  });
  await page.goto("/");

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: /Compose email/ }).click();
  const popup = await popupPromise;
  await popup.waitForURL("https://mail.google.com/**");
  expect(popup.url()).toBe("https://mail.google.com/mail/u/sandro@stimuli.digital/#all/mock-gmail-thread-maya");
  await expect(page.locator("#email-dialog")).not.toBeVisible();
});

test("the focused card remains usable on a phone-sized viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Oyster" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Follow up on LinkedIn/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Compose email/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Rules" }).click();
  await expect(page.getByRole("heading", { name: "Who appears here?" })).toBeVisible();
});
