import { expect, test, type Page } from "@playwright/test";

const input = (page: Page) => page.getByRole("textbox", { name: "Message pi" });
const snapshot = (page: Page) => page.evaluate(async () => (await import("/tests/chat-queue/harness.tsx")).snapshot());
const files = (page: Page) => page.getByRole("listbox", { name: "Files" });

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/chat-queue/");
  await expect(input(page)).toHaveAttribute("placeholder", "Ask pi anything");
});

test("@ picks a project file and sends it as a resource link in place", async ({ page }) => {
  await input(page).pressSequentially("Why does @chatv");
  await expect(files(page).getByRole("option")).toHaveText(["ChatView.tsxsrc/components/chat"]);
  await input(page).press("Enter");
  await expect(input(page)).toHaveValue("Why does @src/components/chat/ChatView.tsx ");
  await expect(files(page)).toHaveCount(0);
  await input(page).pressSequentially("flicker?");
  await input(page).press("Enter");
  const [request] = (await snapshot(page)).requests;
  expect(request).toEqual([
    { type: "text", text: "Why does " },
    { type: "resource_link", uri: "file:///test/queue/src/components/chat/ChatView.tsx", name: "ChatView.tsx" },
    { type: "text", text: " flicker?" },
  ]);
  await expect(page.locator(".chat-turn .chat-user")).toHaveText("Why does @src/components/chat/ChatView.tsx flicker?");
});

test("the picker follows the keyboard, closes on Esc, and leaves other @words alone", async ({ page }) => {
  await input(page).pressSequentially("@chat");
  await expect(files(page).getByRole("option")).toHaveCount(3);
  await input(page).press("ArrowDown");
  await expect(files(page).getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await input(page).press("Escape");
  await expect(files(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue("@chat");
  await input(page).fill("");
  await input(page).pressSequentially("ask @dave about it");
  await expect(files(page)).toHaveCount(0);
  await input(page).press("Enter");
  expect((await snapshot(page)).requests[0]).toEqual([{ type: "text", text: "ask @dave about it" }]);
});
