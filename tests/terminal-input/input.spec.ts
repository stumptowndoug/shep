import { expect, test } from "@playwright/test";

test("ordinary typing leaves no replay of earlier text on a later input edit", async ({ page }) => {
  await page.goto("/tests/terminal-input/");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("Please FIX this input Issue");
  const before = await page.evaluate(() => {
    const { term, chunks } = (window as any).terminalTest;
    return { sent: chunks.join(""), hidden: term.textarea.value };
  });
  expect(before.sent).toBe("Please FIX this input Issue");
  // Replay the browser's non-composition input edit from xterm issue #6078.
  // No Shift+Enter, shell, agent, or background provider is involved.
  await page.evaluate(() => {
    const { term, chunks } = (window as any).terminalTest;
    chunks.length = 0;
    const textarea = term.textarea;
    const event = new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    textarea.dispatchEvent(event);
    textarea.value = textarea.value.slice(0, -1) + "x";
  });
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.chunks.join(""))).toBe("x");
});

test("unprotected xterm reproduces the old capital-and-space replay", async ({ page }) => {
  await page.goto("/tests/terminal-input/?unguarded");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("Please FIX this input Issue");
  await page.evaluate(() => {
    const { term, chunks } = (window as any).terminalTest;
    chunks.length = 0;
    const event = new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true, keyCode: 229 });
    term.textarea.dispatchEvent(event);
    term.textarea.value = term.textarea.value.slice(0, -1) + "x";
  });
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.chunks.join("").replace(/\s/g, " "))).toBe("P FIX   x");
});

test("ordinary typing stays exact during background output and redraws", async ({ page }) => {
  await page.goto("/tests/terminal-input/");
  await page.locator(".xterm-helper-textarea").focus();
  await page.evaluate(() => {
    const { term } = (window as any).terminalTest;
    (window as any).redraw = setInterval(() => {
      term.write("\x1b[?2026h\x1b[H\x1b[2JBackground output\r\n" + "lines\r\n".repeat(100) + "\x1b[?2026l");
      const end = performance.now() + 8;
      while (performance.now() < end) { /* simulate a busy renderer */ }
    }, 30);
  });
  const text = "Please FIX this input Issue. Mixed CASE, spaces & punctuation! ".repeat(5);
  await page.keyboard.type(text, { delay: 2 });
  await page.evaluate(() => clearInterval((window as any).redraw));
  expect(await page.evaluate(() => (window as any).terminalTest.chunks.join(""))).toBe(text);
});

for (const text of ["é", "e\u0301", "日本語"]) {
  test(`fresh browser input emits only ${JSON.stringify(text)}`, async ({ page }) => {
    await page.goto("/tests/terminal-input/");
    await page.keyboard.type("OLD TEXT");
    await page.evaluate((value) => {
      const { term, chunks } = (window as any).terminalTest;
      chunks.length = 0;
      term.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", keyCode: 229, bubbles: true }));
      term.textarea.value = value;
    }, text);
    await expect.poll(() => page.evaluate(() => (window as any).terminalTest.chunks.join(""))).toBe(text);
  });
}

test("composition commits before an immediately following ordinary key", async ({ page }) => {
  await page.goto("/tests/terminal-input/");
  await page.keyboard.type("OLD TEXT");
  await page.evaluate(async () => {
    const { term, chunks } = (window as any).terminalTest;
    const ta = term.textarea;
    chunks.length = 0;
    const prefix = ta.value;
    ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    ta.value = prefix + "é";
    ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "é", bubbles: true }));
    // Let xterm measure the composition range, then put the next key ahead
    // of its deferred composition-end send (the guard must not clear it).
    await new Promise(resolve => setTimeout(resolve, 0));
    ta.dispatchEvent(new CompositionEvent("compositionend", { data: "é", bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "z", keyCode: 90, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.chunks.join(""))).toBe("éz");
});

test("active composition survives keyboard events and cancels without replay", async ({ page }) => {
  await page.goto("/tests/terminal-input/");
  const text = await page.evaluate(() => {
    const { term } = (window as any).terminalTest;
    const ta = term.textarea;
    ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    ta.value = "にほん";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", keyCode: 229, isComposing: true, bubbles: true }));
    return ta.value;
  });
  expect(text).toBe("にほん");
  await page.evaluate(() => {
    const ta = (window as any).terminalTest.term.textarea;
    ta.value = "";
    ta.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
  });
  await page.keyboard.type("new input");
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.chunks.join(""))).toBe("new input");
});

test("multiline bracketed paste, Enter, arrows, and backspace keep their bytes", async ({ page }) => {
  await page.goto("/tests/terminal-input/");
  await page.evaluate(async () => {
    const { term } = (window as any).terminalTest;
    await new Promise<void>(resolve => term.write("\x1b[?2004h", resolve));
    term.paste("one\ntwo");
  });
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  expect(await page.evaluate(() => (window as any).terminalTest.chunks.join("")))
    .toBe("\x1b[200~one\rtwo\x1b[201~\r\x1b[D\x7f");
});

test("screen reader mode retains its textarea and disposal removes the guard", async ({ page }) => {
  await page.goto("/tests/terminal-input/");
  const values = await page.evaluate(() => {
    const { term, guard } = (window as any).terminalTest;
    const ta = term.textarea;
    term.options.screenReaderMode = true;
    ta.value = "accessible text";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "z", keyCode: 90, bubbles: true }));
    const accessible = ta.value;
    term.options.screenReaderMode = false;
    guard.dispose();
    ta.value = "unmanaged text";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "z", keyCode: 90, bubbles: true, cancelable: true }));
    return [accessible, ta.value];
  });
  expect(values).toEqual(["accessible text", "unmanaged text"]);
});

test("Shep multiline and word-delete shortcuts neither replay nor duplicate text", async ({ page }) => {
  await page.goto("/tests/terminal-input/");
  await page.keyboard.type("First LINE");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Second LINE");
  await page.keyboard.press("Alt+Backspace");
  expect(await page.evaluate(() => (window as any).terminalTest.chunks.join("")))
    .toBe("First LINE\nSecond LINE\x17");
  await page.evaluate(() => {
    const { term, chunks } = (window as any).terminalTest;
    chunks.length = 0;
    term.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", keyCode: 229, bubbles: true }));
    term.textarea.value += "x";
  });
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.chunks.join(""))).toBe("x");
});

test("a subsequent key does not erase a browser edit awaiting xterm's timer", async ({ page }) => {
  await page.goto("/tests/terminal-input/");
  await page.evaluate(() => {
    const { term } = (window as any).terminalTest;
    const ta = term.textarea;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", keyCode: 229, bubbles: true }));
    ta.value = "é";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", keyCode: 37, bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.chunks.join(""))).toBe("\x1b[Dé");
});
