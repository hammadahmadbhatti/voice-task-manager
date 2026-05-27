/**
 * Vitest setup file. Runs once before any test.
 *
 * Strategy: avoid loading the real config module (which would demand real
 * env vars and AWS credentials). Each test that needs config will mock
 * what it needs explicitly.
 */
import { vi } from "vitest";

// Provide just enough env so `config.ts` doesn't refuse to load if a test
// happens to import it transitively.
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";
process.env.DEEPGRAM_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.AWS_REGION = "eu-central-1";
// Tests never connect — repo is mocked. Use a placeholder URL that passes
// the zod URL check in config.ts.
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/vtm_test";
process.env.ALLOW_ANONYMOUS = "true";
process.env.LOG_LEVEL = "fatal";

// Quiet pino output during tests
vi.mock("../utils/logger.js", () => ({
  logger: {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: () => ({
      fatal: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn()
    })
  }
}));
