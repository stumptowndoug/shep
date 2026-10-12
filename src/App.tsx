import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import AppShell from "./components/layout/AppShell";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import { requestAppShutdown } from "./lib/appLifecycle";

/** Without this, one render error unmounts everything and leaves a blank window. */
function AppCrashed({ error }: { error: Error }) {
  // With sessions running, the backend holds the window open until the app confirms
  // quitting; AppShell normally answers, so the close button must still work here.
  useEffect(() => {
    const unlisten = listen<number>("quit-requested", (event) => {
      void requestAppShutdown(false, event.payload);
    });
    return () => { unlisten.then((stop) => stop()); };
  }, []);

  return (
    <div role="alert" className="app-crashed">
      <h1 className="page__title">Something went wrong.</h1>
      <p className="page__lede">Shep hit an error while drawing this window. Reload to get back to work.</p>
      <code className="inline-code">{error.message}</code>
      <button type="button" className="btn-primary" onClick={() => window.location.reload()}>Reload Shep</button>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary fallback={(error) => <AppCrashed error={error} />}>
      <AppShell />
    </ErrorBoundary>
  );
}

export default App;
