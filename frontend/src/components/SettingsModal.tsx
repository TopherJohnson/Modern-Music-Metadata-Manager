import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CloudDownload,
  FolderOpen,
  HardDrive,
  Inbox,
  KeyRound,
  Loader2,
  PlugZap,
  Radio,
  Save,
  Settings,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  testNavidromeConnection,
  testSlskdConnection,
} from "../api/client";
import type {
  HealthResponse,
  IntegrationSettingsResponse,
  LibraryInfo,
  NavidromeSyncResult,
  SlskdStatusResponse,
} from "../types/music";

interface SettingsModalProps {
  open: boolean;
  health: HealthResponse | null;
  libraries: LibraryInfo[];
  onClose: () => void;
  onSaved: (saved: IntegrationSettingsResponse) => void;
}

export function SettingsModal({
  open,
  health,
  libraries,
  onClose,
  onSaved,
}: SettingsModalProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded server state
  const [serverState, setServerState] =
    useState<IntegrationSettingsResponse | null>(null);

  // slskd form state
  const [slskdEnabled, setSlskdEnabled] = useState(false);
  const [slskdUrl, setSlskdUrl] = useState("");
  const [slskdApiKeyInput, setSlskdApiKeyInput] = useState("");
  const [clearSlskdKey, setClearSlskdKey] = useState(false);
  const [testingSlskd, setTestingSlskd] = useState(false);
  const [slskdTestResult, setSlskdTestResult] =
    useState<SlskdStatusResponse | null>(null);

  // Navidrome form state
  const [navEnabled, setNavEnabled] = useState(false);
  const [navUrl, setNavUrl] = useState("");
  const [navUser, setNavUser] = useState("");
  const [navPassInput, setNavPassInput] = useState("");
  const [clearNavPass, setClearNavPass] = useState(false);
  const [navAutoScan, setNavAutoScan] = useState(true);
  const [testingNav, setTestingNav] = useState(false);
  const [navTestResult, setNavTestResult] =
    useState<NavidromeSyncResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSlskdTestResult(null);
    setNavTestResult(null);

    void getIntegrationSettings()
      .then((res) => {
        if (cancelled) return;
        setServerState(res);
        setSlskdEnabled(res.slskd_enabled);
        setSlskdUrl(res.slskd_url ?? "");
        setSlskdApiKeyInput("");
        setClearSlskdKey(false);

        setNavEnabled(res.navidrome_enabled);
        setNavUrl(res.navidrome_url ?? "");
        setNavUser(res.navidrome_user ?? "");
        setNavPassInput("");
        setClearNavPass(false);
        setNavAutoScan(res.navidrome_auto_scan);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Could not load settings."
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const hasSlskdKeySaved = Boolean(
    serverState?.slskd_api_key_set && !clearSlskdKey
  );
  const hasNavPassSaved = Boolean(
    serverState?.navidrome_pass_set && !clearNavPass
  );

  const handleTestSlskd = async () => {
    setTestingSlskd(true);
    setSlskdTestResult(null);
    try {
      const res = await testSlskdConnection({
        url: slskdUrl.trim() || undefined,
        apiKey: slskdApiKeyInput.trim() || undefined,
      });
      setSlskdTestResult(res);
    } catch (err) {
      setSlskdTestResult({
        configured: false,
        connected: false,
        detail:
          err instanceof Error ? err.message : "Connection test failed.",
      });
    } finally {
      setTestingSlskd(false);
    }
  };

  const handleTestNavidrome = async () => {
    setTestingNav(true);
    setNavTestResult(null);
    try {
      const res = await testNavidromeConnection({
        url: navUrl.trim() || undefined,
        user: navUser.trim() || undefined,
        password: navPassInput.trim() || undefined,
      });
      setNavTestResult(res);
    } catch (err) {
      setNavTestResult({
        configured: false,
        triggered: false,
        ok: false,
        detail:
          err instanceof Error ? err.message : "Connection test failed.",
      });
    } finally {
      setTestingNav(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await saveIntegrationSettings({
        slskd_enabled: slskdEnabled,
        slskd_url: slskdUrl.trim(),
        ...(clearSlskdKey
          ? { clear_slskd_api_key: true }
          : slskdApiKeyInput.trim()
            ? { slskd_api_key: slskdApiKeyInput.trim() }
            : {}),
        navidrome_enabled: navEnabled,
        navidrome_url: navUrl.trim(),
        navidrome_user: navUser.trim(),
        ...(clearNavPass
          ? { clear_navidrome_pass: true }
          : navPassInput.trim()
            ? { navidrome_pass: navPassInput.trim() }
            : {}),
        navidrome_auto_scan: navAutoScan,
      });
      setServerState(saved);
      setSlskdApiKeyInput("");
      setClearSlskdKey(false);
      setNavPassInput("");
      setClearNavPass(false);
      onSaved(saved);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save settings."
      );
    } finally {
      setSaving(false);
    }
  };

  const stagingConfigured = Boolean(health?.staging_configured);
  const stagingOk = Boolean(
    health?.staging_dir_exists &&
      health?.staging_dir_readable &&
      health?.staging_dir_writable
  );

  return (
    <div
      id="settings-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
              <Settings className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink-primary">
                Settings & Integrations
              </h2>
              <p className="text-[11px] text-ink-muted">
                Configure optional services in-app — saved to{" "}
                <span className="font-mono text-ink-secondary">
                  /config/m4.db
                </span>{" "}
                and applied immediately without restart.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink-primary cursor-pointer"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <form
          onSubmit={handleSave}
          className="flex flex-1 flex-col min-h-0 overflow-hidden"
        >
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-xs text-ink-secondary gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                <span>Loading settings...</span>
              </div>
            ) : (
              <>
                {error && (
                  <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                {/* slskd Integration Card */}
                <section className="rounded-xl border border-border-subtle bg-canvas/70 p-4 space-y-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
                        <CloudDownload className="h-3.5 w-3.5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-xs font-semibold text-ink-primary">
                            slskd (Soulseek)
                          </h3>
                          {serverState?.slskd_from_env && (
                            <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
                              from env
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-ink-muted mt-0.5">
                          Search Soulseek for missing tracks and monitor live
                          downloads right from M⁴. Completely optional.
                        </p>
                      </div>
                    </div>

                    <label className="inline-flex items-center gap-2 cursor-pointer shrink-0 select-none">
                      <span className="text-[11px] font-medium text-ink-secondary">
                        {slskdEnabled ? "Enabled" : "Disabled"}
                      </span>
                      <input
                        id="settings-slskd-enabled"
                        type="checkbox"
                        checked={slskdEnabled}
                        onChange={(e) => setSlskdEnabled(e.target.checked)}
                        className="h-4 w-4 accent-[var(--color-accent)] cursor-pointer"
                      />
                    </label>
                  </div>

                  <div
                    className={`grid grid-cols-1 sm:grid-cols-2 gap-3 transition-opacity ${
                      slskdEnabled ? "opacity-100" : "opacity-55"
                    }`}
                  >
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-ink-secondary">
                        slskd URL
                      </span>
                      <input
                        id="settings-slskd-url"
                        type="url"
                        value={slskdUrl}
                        onChange={(e) => setSlskdUrl(e.target.value)}
                        placeholder="http://gluetun:5030"
                        className="m4-input h-8 text-xs font-mono"
                      />
                    </label>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <label
                          htmlFor="settings-slskd-key"
                          className="text-[11px] font-medium text-ink-secondary"
                        >
                          API Key
                        </label>
                        {hasSlskdKeySaved ? (
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-medium text-emerald-300">
                              <KeyRound className="h-2.5 w-2.5" />
                              Saved
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setClearSlskdKey(true);
                                setSlskdApiKeyInput("");
                              }}
                              className="inline-flex items-center gap-0.5 text-[10px] text-ink-muted hover:text-danger cursor-pointer"
                              title="Clear saved API key"
                            >
                              <Trash2 className="h-2.5 w-2.5" />
                              Clear
                            </button>
                          </div>
                        ) : clearSlskdKey ? (
                          <span className="text-[10px] text-amber-300">
                            Will clear on save
                          </span>
                        ) : null}
                      </div>
                      <input
                        id="settings-slskd-key"
                        type="password"
                        value={slskdApiKeyInput}
                        onChange={(e) => {
                          setSlskdApiKeyInput(e.target.value);
                          if (e.target.value) setClearSlskdKey(false);
                        }}
                        placeholder={
                          hasSlskdKeySaved
                            ? "•••••••• (leave blank to keep saved)"
                            : "Paste slskd API key"
                        }
                        autoComplete="new-password"
                        className="m4-input h-8 text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                    <button
                      id="settings-test-slskd-btn"
                      type="button"
                      onClick={handleTestSlskd}
                      disabled={testingSlskd}
                      className="m4-btn-secondary h-7 px-2.5 text-[11px]"
                    >
                      {testingSlskd ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <PlugZap className="h-3 w-3 text-accent" />
                      )}
                      <span>Test Connection</span>
                    </button>

                    {slskdTestResult && (
                      <div
                        id="settings-slskd-test-result"
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                          slskdTestResult.connected
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                            : "border-danger/40 bg-danger/10 text-danger"
                        }`}
                      >
                        {slskdTestResult.connected ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate max-w-[340px]">
                          {slskdTestResult.detail ??
                            (slskdTestResult.connected
                              ? "Connected to slskd"
                              : "Connection failed")}
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                {/* Navidrome Integration Card */}
                <section className="rounded-xl border border-border-subtle bg-canvas/70 p-4 space-y-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-ok">
                        <Radio className="h-3.5 w-3.5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-xs font-semibold text-ink-primary">
                            Navidrome (Subsonic)
                          </h3>
                          {serverState?.navidrome_from_env && (
                            <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
                              from env
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-ink-muted mt-0.5">
                          Trigger Subsonic library rescans automatically when
                          editing tags or importing from Staging.
                        </p>
                      </div>
                    </div>

                    <label className="inline-flex items-center gap-2 cursor-pointer shrink-0 select-none">
                      <span className="text-[11px] font-medium text-ink-secondary">
                        {navEnabled ? "Enabled" : "Disabled"}
                      </span>
                      <input
                        id="settings-navidrome-enabled"
                        type="checkbox"
                        checked={navEnabled}
                        onChange={(e) => setNavEnabled(e.target.checked)}
                        className="h-4 w-4 accent-[var(--color-accent)] cursor-pointer"
                      />
                    </label>
                  </div>

                  <div
                    className={`space-y-3 transition-opacity ${
                      navEnabled ? "opacity-100" : "opacity-55"
                    }`}
                  >
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-ink-secondary">
                        Navidrome URL
                      </span>
                      <input
                        id="settings-navidrome-url"
                        type="url"
                        value={navUrl}
                        onChange={(e) => setNavUrl(e.target.value)}
                        placeholder="http://navidrome:4533"
                        className="m4-input h-8 text-xs font-mono"
                      />
                    </label>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="block space-y-1">
                        <span className="text-[11px] font-medium text-ink-secondary">
                          Username
                        </span>
                        <input
                          id="settings-navidrome-user"
                          type="text"
                          value={navUser}
                          onChange={(e) => setNavUser(e.target.value)}
                          placeholder="admin"
                          autoComplete="off"
                          className="m4-input h-8 text-xs"
                        />
                      </label>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <label
                            htmlFor="settings-navidrome-pass"
                            className="text-[11px] font-medium text-ink-secondary"
                          >
                            Password
                          </label>
                          {hasNavPassSaved ? (
                            <div className="flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-medium text-emerald-300">
                                <KeyRound className="h-2.5 w-2.5" />
                                Saved
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setClearNavPass(true);
                                  setNavPassInput("");
                                }}
                                className="inline-flex items-center gap-0.5 text-[10px] text-ink-muted hover:text-danger cursor-pointer"
                                title="Clear saved password"
                              >
                                <Trash2 className="h-2.5 w-2.5" />
                                Clear
                              </button>
                            </div>
                          ) : clearNavPass ? (
                            <span className="text-[10px] text-amber-300">
                              Will clear on save
                            </span>
                          ) : null}
                        </div>
                        <input
                          id="settings-navidrome-pass"
                          type="password"
                          value={navPassInput}
                          onChange={(e) => {
                            setNavPassInput(e.target.value);
                            if (e.target.value) setClearNavPass(false);
                          }}
                          placeholder={
                            hasNavPassSaved
                              ? "•••••••• (leave blank to keep saved)"
                              : "Navidrome password"
                          }
                          autoComplete="new-password"
                          className="m4-input h-8 text-xs"
                        />
                      </div>
                    </div>

                    <label className="inline-flex items-center gap-2 text-[11px] text-ink-secondary cursor-pointer select-none">
                      <input
                        id="settings-navidrome-autoscan"
                        type="checkbox"
                        checked={navAutoScan}
                        onChange={(e) => setNavAutoScan(e.target.checked)}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)] cursor-pointer"
                      />
                      <span>
                        Automatically notify Navidrome after tag edits, merges,
                        and Staging imports
                      </span>
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                    <button
                      id="settings-test-navidrome-btn"
                      type="button"
                      onClick={handleTestNavidrome}
                      disabled={testingNav}
                      className="m4-btn-secondary h-7 px-2.5 text-[11px]"
                    >
                      {testingNav ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <PlugZap className="h-3 w-3 text-ok" />
                      )}
                      <span>Test Connection</span>
                    </button>

                    {navTestResult && (
                      <div
                        id="settings-navidrome-test-result"
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                          navTestResult.ok
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                            : "border-danger/40 bg-danger/10 text-danger"
                        }`}
                      >
                        {navTestResult.ok ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate max-w-[340px]">
                          {navTestResult.detail ??
                            (navTestResult.ok
                              ? "Connected to Navidrome"
                              : "Connection failed")}
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                {/* Read-Only Container Mounts Overview */}
                <section className="rounded-xl border border-border-subtle bg-canvas/50 p-4 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-3.5 w-3.5 text-ink-muted" />
                    <h3 className="text-xs font-semibold text-ink-primary">
                      Container Mounts
                    </h3>
                    <span className="text-[10px] text-ink-muted">
                      (configured in docker-compose.yml)
                    </span>
                  </div>

                  <div className="space-y-1.5 text-[11px]">
                    {libraries.map((lib) => {
                      const ok = lib.exists && lib.readable && lib.writable;
                      return (
                        <div
                          key={lib.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle/70 bg-surface/60 px-3 py-1.5"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`h-2 w-2 rounded-full shrink-0 ${
                                ok ? "bg-ok" : "bg-danger"
                              }`}
                            />
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
                            <span className="font-medium text-ink-primary truncate">
                              {lib.name}
                            </span>
                            <span className="font-mono text-ink-muted truncate">
                              {lib.path}
                            </span>
                          </div>
                          <span className="font-mono text-[10px] text-ink-muted shrink-0">
                            {ok ? "rw ready" : !lib.exists ? "missing" : "check perms"}
                          </span>
                        </div>
                      );
                    })}

                    <div className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle/70 bg-surface/60 px-3 py-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`h-2 w-2 rounded-full shrink-0 ${
                            !stagingConfigured
                              ? "bg-ink-muted/60"
                              : stagingOk
                                ? "bg-cyan-400"
                                : "bg-danger"
                          }`}
                        />
                        <Inbox className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
                        <span className="font-medium text-ink-primary">
                          Staging / Inbox
                        </span>
                        <span className="font-mono text-ink-muted truncate">
                          {stagingConfigured
                            ? (health?.staging_dir ?? "/downloads")
                            : "Not mounted (set M4_STAGING_DIR)"}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-ink-muted shrink-0">
                        {!stagingConfigured
                          ? "optional"
                          : stagingOk
                            ? "rw ready"
                            : "check mount"}
                      </span>
                    </div>

                    {health?.config_dir && (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle/70 bg-surface/60 px-3 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`h-2 w-2 rounded-full shrink-0 ${
                              health.config_dir_writable ? "bg-ok" : "bg-danger"
                            }`}
                          />
                          <HardDrive className="h-3.5 w-3.5 shrink-0 text-ink-secondary" />
                          <span className="font-medium text-ink-primary">
                            Config & DB
                          </span>
                          <span className="font-mono text-ink-muted truncate">
                            {health.config_dir}
                          </span>
                        </div>
                        <span className="font-mono text-[10px] text-ink-muted shrink-0">
                          {health.config_dir_writable ? "writable" : "read-only"}
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-elevated/40 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="m4-btn-secondary h-8 px-3 text-xs"
            >
              Cancel
            </button>
            <button
              id="settings-save-btn"
              type="submit"
              disabled={loading || saving}
              className="m4-btn-primary h-8 px-3.5 text-xs"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              <span>{saving ? "Saving..." : "Save Settings"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
