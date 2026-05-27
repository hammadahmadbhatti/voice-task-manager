import createMiddleware from "next-intl/middleware";
import { defaultLocale, locales } from "./i18n/config";

/**
 * Locale routing — paths get prefixed with /en or /de.
 * "always" prefix means /en is explicit; lets us share auth callback URLs cleanly.
 */
export default createMiddleware({
  locales: locales as unknown as string[],
  defaultLocale,
  localePrefix: "always"
});

export const config = {
  // Skip Next internals + the static `auth/callback` if you don't want a prefix.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"]
};
