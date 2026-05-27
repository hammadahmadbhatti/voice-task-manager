import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { locales, type Locale } from "@/i18n/config";

export function generateStaticParams() {
  return locales.map((l) => ({ locale: l }));
}

export default async function LocaleLayout({
  children,
  params: { locale }
}: {
  children: ReactNode;
  params: { locale: string };
}) {
  if (!(locales as readonly string[]).includes(locale)) notFound();
  // Enable static rendering with next-intl. Without this, `useTranslations`
  // inside a child Server Component opts the whole route into dynamic rendering.
  setRequestLocale(locale);

  const messages = await getMessages();
  return (
    <NextIntlClientProvider locale={locale as Locale} messages={messages}>
      <div className="min-h-screen flex flex-col">{children}</div>
    </NextIntlClientProvider>
  );
}
