import { expect, test, type Page } from "@playwright/test";

const input = (page: Page) => page.getByRole("textbox", { name: "Message pi" });
const snapshot = (page: Page) => page.evaluate(async () => (await import("/tests/chat-queue/harness.tsx")).snapshot());
const finish = (page: Page) => page.evaluate(async () => (await import("/tests/chat-queue/harness.tsx")).finish());

async function open(page: Page, query: string) {
  await page.goto(`/tests/chat-queue/${query}`);
  await expect(input(page)).toHaveAttribute("placeholder", "Ask pi anything");
}

/** Paste a generated PNG of the given size into the composer, as a screenshot paste would. */
async function pasteImage(page: Page, width = 40, height = 30, name = "shot.png") {
  await input(page).evaluate(async (node, { width, height, name }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.fillRect(0, 0, width, height);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], name, { type: "image/png" }));
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { width, height, name });
}

test.beforeEach(({ browserName }) => {
  // WebKit can't construct a paste event carrying files.
  test.skip(browserName === "webkit");
});

test("pasted images are sent before the prompt text and shown with it", async ({ page }) => {
  await open(page, "?images");
  await pasteImage(page);
  await expect(page.getByRole("img", { name: "shot.png" })).toBeVisible();
  await page.getByRole("button", { name: "Remove shot.png" }).click();
  await expect(page.locator(".chat-attachment")).toHaveCount(0);
  await pasteImage(page);
  await input(page).fill("What’s wrong here?");
  await input(page).press("Enter");
  await expect(page.locator(".chat-attachment")).toHaveCount(0);
  const [request] = (await snapshot(page)).requests;
  expect(request.map(block => block.type)).toEqual(["image", "text"]);
  expect(request[0].mimeType).toBe("image/png");
  await expect(page.locator(".chat-turn .chat-user-images img")).toHaveCount(1);
  await expect(page.locator(".chat-turn .chat-user")).toHaveText("What’s wrong here?");
});

test("an image alone can be sent, queued while the agent works, and large ones are scaled down", async ({ page }) => {
  await open(page, "?images");
  await input(page).fill("First");
  await input(page).press("Enter");
  await pasteImage(page, 3000, 1200, "wide.png");
  await expect(page.locator(".chat-attachment")).toHaveCount(1);
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  await expect(page.getByRole("group", { name: "Queued images" }).locator("img")).toHaveCount(1);
  await finish(page);
  await expect(page.getByRole("group", { name: "Queued images" })).toHaveCount(0);
  const { requests } = await snapshot(page);
  expect(requests).toHaveLength(2);
  expect(requests[1].map(block => block.type)).toEqual(["image"]);
  const width = await page.evaluate(async data => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    return image.naturalWidth;
  }, requests[1][0].data!);
  expect(width).toBe(2000);
});

test("agents that don’t accept images get no attach button and a notice on paste", async ({ page }) => {
  await open(page, "");
  await expect(page.getByRole("button", { name: "Attach images" })).toHaveCount(0);
  await pasteImage(page);
  await expect(page.locator(".chat-attachment")).toHaveCount(0);
  expect((await snapshot(page)).chat.acceptsImages).toBe(false);
});
