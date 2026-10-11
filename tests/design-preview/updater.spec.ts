import { expect, test } from "@playwright/test";

for (const fails of [false, true]) {
  test(`restart waits for installation ${fails ? "failure" : "completion"}`, async ({ page }) => {
    await page.goto("/tests/design-preview/");
    const result = await page.evaluate(async (fails) => {
      const { useUpdateStore: store } = await import("/src/stores/useUpdateStore.ts");
      let finish!: () => void;
      let attempts = 0;
      store.setState({ status: "available", _update: {
        downloadAndInstall: async (callback) => {
          attempts++;
          callback({ event: "Finished" });
          await new Promise<void>(resolve => { finish = resolve; });
          if (fails) throw new Error("Signature verification failed");
        },
      } });
      const installing = store.getState().downloadAndInstall();
      await store.getState().downloadAndInstall();
      await store.getState().checkForUpdate();
      await store.getState().restartApp();
      const pending = store.getState().status;
      finish();
      await installing;
      return { pending, attempts, status: store.getState().status, error: store.getState().error };
    }, fails);
    expect(result.pending).toBe("installing");
    expect(result.attempts).toBe(1);
    expect(result.status).toBe(fails ? "available" : "ready");
    expect(result.error).toBe(fails ? "Signature verification failed" : null);
  });
}
