import { expect, test } from "@playwright/test";

test("a finished turn lists the files it changed, with diffs on demand and a way to open each", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    const edit = (id: string, path: string, oldText: string, newText: string, status = "completed") =>
      ({ kind: "tool", id, toolCallId: id, title: `Edit ${path}`, toolKind: "edit", status, output: "", diffs: [{ path, oldText, newText }] });
    useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: [{
      id: 0, prompt: "tidy the header", startedAt: 1, endedAt: 4000, stopReason: "end_turn", items: [
        edit("a", "/preview/shep/src/components/Header.tsx", "const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 3;\nconst c = 4;"),
        edit("b", "/preview/shep/README.md", "# Shep", "# Shep\n\nA workspace."),
        edit("c", "/preview/shep/src/broken.ts", "x", "y", "failed"),
        { kind: "message", id: "m", messageId: null, text: "Tidied the header." },
      ],
    }] }));
  });
  const changes = page.locator(".chat-view:visible .chat-changes");
  await expect(changes.locator("summary")).toHaveText("Changed 2 files+4 −1");
  await changes.locator("summary").click();
  const header = changes.getByRole("button", { name: /^Header\.tsx/ });
  await expect(header).toContainText("src/components");
  await expect(changes).not.toContainText("broken.ts");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(changes.locator(".chat-diff")).toHaveCount(1);
  await changes.getByRole("button", { name: "Open README.md in editor" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-preview-last-edited", "/preview/shep/README.md");
});

test("a turn still running shows no change summary yet", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "working", turns: [{
      id: 0, prompt: "edit", startedAt: 1, endedAt: null, stopReason: null, items: [
        { kind: "tool", id: "a", toolCallId: "a", title: "Edit", toolKind: "edit", status: "completed", output: "", diffs: [{ path: "/preview/shep/a.ts", oldText: "a", newText: "b" }] },
      ],
    }] }));
  });
  const work = page.locator(".chat-view:visible .chat-worked");
  await expect(work.locator("summary")).toHaveText("WorkingEdit1 step · 1 edit");
  await work.locator("summary").click();
  await expect(page.locator(".chat-view:visible .chat-tool")).toHaveCount(1);
  await expect(page.locator(".chat-view:visible .chat-changes")).toHaveCount(0);
});
