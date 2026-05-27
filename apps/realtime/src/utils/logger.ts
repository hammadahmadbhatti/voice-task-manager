import pino from "pino";
import { config, isProd } from "../config.js";

/**
 * Pino logger. In dev we use pino-pretty for readable output; in prod
 * we emit JSON for CloudWatch Logs / Loki / etc.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname"
          }
        }
      })
});

export type Logger = typeof logger;
