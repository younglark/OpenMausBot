import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

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

/** wslc's reduced isolation is a visible, opt-in downgrade — never reported as hardened. */
export function WslcSecurityNotice() {
  return <p className="text-[12px] leading-relaxed text-warning">{t("vm.security.relaxed")}</p>;
}
