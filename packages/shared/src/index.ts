/**
 * Public surface of @vtm/shared.
 *
 * Everything is re-exported flat — tools, prompts, types, protocol all
 * live at the top level. The legacy `Tools` and `Prompts` namespaces are
 * kept as aliases for callers that prefer them.
 */
export * from "./types.js";
export * from "./protocol.js";
export * from "./schemas/index.js";
export * from "./prompts/index.js";

// Namespaced aliases (optional ergonomics)
export * as Tools from "./schemas/index.js";
export * as Prompts from "./prompts/index.js";
