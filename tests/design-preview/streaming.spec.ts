import { expect, test } from "@playwright/test";

for (const boundary of ["complete", "permission", "exit", "close"] as const) {
  test(`buffered tokens stay ordered at ${boundary}`, async ({ page }) => {
    await page.goto("/tests/design-preview/?view=chat");
    const result = await page.evaluate(async (boundary) => {
      const { startChat, sendPrompt, closeChat } = await import("/src/lib/acp/chatSessions.ts");
      const { useChatStore } = await import("/src/stores/useChatStore.ts");
      const { CODING_ASSISTANTS } = await import("/src/components/sidebar/constants.ts");
      const base = window.__TAURI_INTERNALS__.invoke;
      let channel;
      let promptId;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args, ...rest) => {
        if (cmd === "spawn_acp_agent") channel = args.onOutput;
        if (cmd === "write_acp_agent") {
          const message = JSON.parse(args.line);
          if (message.method === "session/prompt") promptId = message.id;
        }
        return base(cmd, args, ...rest);
      };
      const chatId = await startChat({ assistant: CODING_ASSISTANTS[0], repoPath: "/preview/shep", mode: "standard" });
      const until = async (ready: () => boolean) => {
        const deadline = performance.now() + 2000;
        while (!ready()) {
          if (performance.now() > deadline) throw new Error("Mock chat did not become ready");
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      };
      await until(() => useChatStore.getState().chats[chatId]?.status === "ready");
      sendPrompt(chatId, "wait");
      await until(() => promptId !== undefined);
      const emit = (message: object) => channel.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", ...message }) });
      // Hold animation frames so only the lifecycle boundary can flush these tokens.
      const request = window.requestAnimationFrame;
      const cancel = window.cancelAnimationFrame;
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      let publications = 0;
      const unsubscribe = useChatStore.subscribe(() => { publications++; });
      window.requestAnimationFrame = fn => { frames.set(++nextFrame, fn); return nextFrame; };
      window.cancelAnimationFrame = id => { frames.delete(id); };
      try {
        for (const text of ["first ", "second ", "last"]) emit({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
        const before = publications;
        const scheduled = frames.size;
        if (boundary === "complete") {
          emit({ id: promptId, result: { stopReason: "end_turn" } });
          await until(() => useChatStore.getState().chats[chatId]?.status === "ready");
        } else if (boundary === "permission") {
          emit({ id: "permission-test", method: "session/request_permission", params: { toolCall: { title: "Run test" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
        } else if (boundary === "exit") {
          channel.onmessage({ event: "exit", data: { code: 1, stderr: "Test exit" } });
        } else {
          await closeChat(chatId);
        }
        const chat = useChatStore.getState().chats[chatId];
        const turn = chat?.turns[0];
        const after = {
          before, scheduled, remainingFrames: frames.size, exists: Boolean(chat), status: chat?.status,
          closed: turn?.endedAt != null, kinds: turn?.items.map(item => item.kind),
          text: turn?.items.filter(item => item.kind === "message").map(item => item.text).join(""),
        };
        if (boundary !== "close") await closeChat(chatId);
        return after;
      } finally {
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
        unsubscribe();
      }
    }, boundary);
    expect(result.before).toBe(0);
    expect(result.scheduled).toBe(1);
    expect(result.remainingFrames).toBe(0);
    if (boundary === "close") expect(result.exists).toBe(false);
    else {
      expect(result.text).toBe("first second last");
      expect(result.closed).toBe(boundary !== "permission");
      expect(result.kinds).toEqual(boundary === "permission" ? ["message", "permission"] : ["message"]);
      expect(result.status).toBe(boundary === "complete" ? "ready" : boundary === "exit" ? "exited" : "working");
    }
  });
}
