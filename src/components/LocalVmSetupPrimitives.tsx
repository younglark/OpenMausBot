import type { ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Switch } from "./SettingsPrimitives";

/** Numbered setup step. Extracted from LocalComputerSection.tsx, which is size-ratcheted. */
export function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col items-start gap-2 [&>*]:max-w-full">{children}</div>}
      </div>
    </div>
  );
}

/** A Local VM runtime action; the shared settings UI keeps the union so button and pending state agree. */
export type LocalVmAction = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

/** Shared button for the Local VM runtime actions. Extracted from LocalComputerSection.tsx, which is size-ratcheted. */
export function ActionButton({ action, pending, children, onClick, danger = false }: {
  action: LocalVmAction;
  pending: LocalVmAction | null;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-busy={pending === action}
      disabled={pending !== null}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-50",
        danger ? "bg-danger/15 text-danger hover:bg-danger/20" : "bg-accent text-white hover:brightness-110",
      )}
    >
      {pending === action && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

/** wslc's reduced isolation is a visible, opt-in downgrade — never reported as hardened. */
export function WslcSecurityNotice() {
  return <p className="text-[12px] leading-relaxed text-warning">{t("vm.security.relaxed")}</p>;
}

/** OMB_WSLC_COMPUTERS overrides the saved switch, so the row explains that instead of pretending to be editable. */
export function LocalVmWslcSetting({ enabled, forced, disabled, onSave }: {
  enabled: boolean;
  forced: boolean;
  disabled: boolean;
  onSave: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{t("vm.wslc.label")}</div>
        <div className="text-[12px] leading-relaxed text-ink-secondary">{forced ? t("vm.wslc.forced") : t("vm.wslc.detail")}</div>
      </div>
      <Switch
        checked={enabled}
        disabled={disabled || forced}
        aria-label={t("vm.wslc.label")}
        onClick={() => onSave(!enabled)}
      />
    </div>
  );
}
