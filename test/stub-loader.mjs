/** Loader hook: stub the Pi SDK packages so index.ts can run under node:test. */
export async function resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: "stub://pi-coding-agent", shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-ai") {
    return { url: "stub://pi-ai", shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === "stub://pi-coding-agent") {
    return {
      format: "module",
      source: `export function getAgentDir(){ return globalThis.__PI_MAXOUT_TEST_AGENT_DIR ?? "/tmp"; }`,
      shortCircuit: true,
    };
  }
  if (url === "stub://pi-ai") {
    return {
      format: "module",
      source: `export function isContextOverflow(){ return globalThis.__PI_MAXOUT_TEST_OVERFLOW === true; }`,
      shortCircuit: true,
    };
  }
  return next(url, context);
}
