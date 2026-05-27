import { getRequestConfig } from "next-intl/server";
import { defaultLocale, locales } from "./config";

export default getRequestConfig(async ({ locale }) => {
  const safe = (locales as readonly string[]).includes(locale ?? "")
    ? locale!
    : defaultLocale;
  const messages = (await import(`../../messages/${safe}.json`)).default;
  return { messages, locale: safe };
});
