import { useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backgroundPushSupport } from "../background-push";
import { useOptionalWorkspace } from "../workspace-context";
import {
  notificationPermission,
  requestNotificationPermission,
  type createNotificationPreferences,
  type NotificationPermissionState,
  type NotificationPreferences,
} from "../notifications";
import { Switch } from "./ui/switch";

const previewState = createStore<{ busy: boolean; error?: string }>(() => ({ busy: false }));

export function NotificationSettings({
  preferences,
  preview = false,
}: {
  preferences: ReturnType<typeof createNotificationPreferences>;
  preview?: boolean;
}) {
  const values = useStore(preferences.store);
  const workspace = useOptionalWorkspace();
  const background = preview ? undefined : workspace?.backgroundPush;
  const pushState = useStore(background?.store ?? previewState);
  const [permission, setPermission] = useState<NotificationPermissionState>(notificationPermission);
  const [requesting, setRequesting] = useState(false);
  const unsupported = backgroundPushSupport();
  useEffect(() => {
    const sync = () => {
      setPermission(notificationPermission());
      preferences.sync();
    };
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
    };
  }, [preferences]);
  async function update(changes: Partial<NotificationPreferences>) {
    if (background && (values.background || changes.background)) {
      await background.apply(changes, changes.background === true);
      setPermission(notificationPermission());
      return;
    }
    preferences.update(changes);
  }
  async function enable(enabled: boolean) {
    if (!enabled) {
      await update({ enabled: false });
      return;
    }
    setRequesting(true);
    const result = await requestNotificationPermission();
    setPermission(result);
    preferences.update({ enabled: result === "granted" });
    setRequesting(false);
  }
  const busy = requesting || pushState.busy;
  const enabled = values.enabled && permission === "granted";
  const status =
    permission === "denied" ? "Allow notifications in your browser's site settings." : undefined;
  return (
    <section className="space-y-6 mb-8" aria-label="Notifications">
      <h2 className="text-lg font-semibold">Notifications</h2>
      <div className="space-y-4">
        <NotificationSetting
          label="Browser notifications"
          value={enabled}
          disabled={busy || permission === "unsupported" || permission === "denied"}
          onChange={(value) => void enable(value)}
        />
        <div className="pl-4 space-y-4">
          <NotificationSetting
            label="Response finished or input needed"
            value={values.completion}
            disabled={busy || !enabled}
            onChange={(completion) => void update({ completion })}
          />
          <NotificationSetting
            label="Run failed"
            value={values.failure}
            disabled={busy || !enabled}
            onChange={(failure) => void update({ failure })}
          />
        </div>
      </div>
      <NotificationSetting
        label="Background push"
        description="Also notify when Lilac is closed."
        value={values.background}
        disabled={busy || (!values.background && (!enabled || Boolean(unsupported)))}
        onChange={(value) => void update({ background: value })}
      />
      {pushState.error || status || unsupported ? (
        <p role="status" className="text-sm text-muted-foreground">
          {pushState.error || status || unsupported}
        </p>
      ) : null}
    </section>
  );
}
function NotificationSetting({
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <label htmlFor={id}>{label}</label>
        {description ? (
          <p id={`${id}-description`} className="text-sm text-muted-foreground mt-1">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        className="mt-0.5"
        aria-describedby={description ? `${id}-description` : undefined}
        checked={value}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}
