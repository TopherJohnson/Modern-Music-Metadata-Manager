import { useState, type FormEvent } from "react";
import { AlertCircle, Disc3, Loader2, Lock } from "lucide-react";
import { login } from "../api/client";
import type { AuthStatusResponse } from "../types/music";

interface LoginScreenProps {
  onLoggedIn: (status: AuthStatusResponse) => void;
}

export function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter both username and password.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const status = await login(username.trim(), password);
      onLoggedIn(status);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid username or password."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-canvas px-4 text-ink-primary">
      <div className="w-full max-w-sm rounded-2xl border border-border-strong bg-surface p-6 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border-strong bg-surface-elevated text-accent">
            <Disc3 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-ink-primary">
              M<sup className="ml-0.5 text-[11px] font-bold text-accent">4</sup>
            </h1>
            <p className="text-xs text-ink-muted">
              Modern Music Metadata Manager
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              id="login-error-banner"
              className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs text-ink-primary"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label
              htmlFor="login-username"
              className="mb-1.5 block text-xs font-medium text-ink-secondary"
            >
              Username
            </label>
            <input
              id="login-username"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
              placeholder="admin"
              className="m4-input h-9 text-xs"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="mb-1.5 block text-xs font-medium text-ink-secondary"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              placeholder="••••••••"
              className="m4-input h-9 text-xs"
            />
          </div>

          <button
            id="login-submit-btn"
            type="submit"
            disabled={submitting}
            className="m4-btn-primary h-9 w-full justify-center text-xs"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p className="mt-5 text-center font-mono text-[10px] text-ink-muted">
          Basic Auth enabled via M4_AUTH_USER / M4_AUTH_PASS
        </p>
      </div>
    </div>
  );
}
