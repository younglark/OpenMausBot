import { useState } from "react";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";
import { LocalVmWslcSetting } from "./LocalVmSetupPrimitives";

export function LocalVmRuntimeCard({ enabled, forced, disabled, onSaved }: {
  enabled: boolean;
  forced: boolean;
  disabled: boolean;
  onSaved: (enabled: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (wslc: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { wslc } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.wslc.error"));
      onSaved(wslc);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t("vm.wslc.title")} subtitle={t("vm.wslc.subtitle")}>
      <LocalVmWslcSetting
        enabled={enabled}
        forced={forced}
        disabled={disabled || saving}
        onSave={(next) => void save(next)}
      />
      {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
    </Card>
  );
}
