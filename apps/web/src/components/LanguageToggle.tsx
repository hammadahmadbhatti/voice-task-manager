"use client";

import { usePathname, useRouter } from "next/navigation";
import { clsx } from "clsx";
import { locales, type Locale } from "@/i18n/config";

interface LanguageToggleProps {
  currentLocale: Locale;
}

export function LanguageToggle({ currentLocale }: LanguageToggleProps) {
  const router = useRouter();
  const pathname = usePathname();

  const switchTo = (next: Locale) => {
    if (next === currentLocale) return;
    // Replace the leading locale segment.
    const rest = pathname?.replace(new RegExp(`^/(${locales.join("|")})`), "") ?? "/";
    router.push(`/${next}${rest || "/"}`);
  };

  return (
    <div className="inline-flex rounded-full bg-white/70 border border-black/5 p-1 text-xs">
      {locales.map((l) => (
        <button
          key={l}
          onClick={() => switchTo(l)}
          className={clsx(
            "px-3 py-1 rounded-full transition",
            l === currentLocale
              ? "bg-ink text-cream"
              : "text-muted hover:text-ink"
          )}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
