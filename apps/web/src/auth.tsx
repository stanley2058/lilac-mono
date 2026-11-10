import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { useEffect, useState, type ComponentProps } from "react";
import { localLogin } from "./http";
import { ErrorNotice } from "./components/ui";

export function LocalLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit: NonNullable<ComponentProps<"form">["onSubmit"]> = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    const result = await localLogin(
      String(data.get("username") ?? ""),
      String(data.get("password") ?? ""),
    );
    setBusy(false);
    result.match({
      ok: () => {
        form.reset();
        onSignedIn();
      },
      err: (failure) => setError(failure.message),
    });
  };
  return (
    <form className="login-form grid gap-4" onSubmit={submit}>
      <label>
        Username
        <Input name="username" autoComplete="username" required autoFocus />
      </label>
      <label>
        Password
        <Input name="password" type="password" autoComplete="current-password" required />
      </label>
      <ErrorNotice message={error || undefined} />
      <Button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export function ThemeInitialization() {
  useEffect(() => {
    document.documentElement.style.colorScheme = "light dark";
  }, []);
  return null;
}
