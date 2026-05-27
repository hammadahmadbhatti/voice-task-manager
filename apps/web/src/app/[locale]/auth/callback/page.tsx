"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { completeSignIn } from "@/lib/cognito";
import type { Locale } from "@/i18n/config";

export default function AuthCallback({
  params
}: {
  params: { locale: Locale };
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");

    if (err) {
      setError(`Sign-in failed: ${err}`);
      return;
    }
    if (!code) {
      setError("No code parameter — try again from the sign-in button.");
      return;
    }

    completeSignIn(code)
      .then(() => {
        router.replace(`/${params.locale}`);
      })
      .catch((e) => {
        console.error(e);
        setError(e?.message ?? "Sign-in failed");
      });
  }, [params.locale, router]);

  return (
    <main className="flex-1 flex items-center justify-center">
      {error ? (
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <a href={`/${params.locale}`} className="underline">
            Back home
          </a>
        </div>
      ) : (
        <p className="text-muted">Signing you in…</p>
      )}
    </main>
  );
}
