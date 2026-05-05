#!/usr/bin/env bun
import { config } from 'dotenv';

// Load environment variables FIRST so PHOENIX_* vars are available to telemetry.
config({ quiet: true });

// Initialize Phoenix/OpenInference telemetry BEFORE any LangChain/openai imports
// so the auto-instrumentation can patch the openai SDK as it is loaded.
// Set PHOENIX_DISABLED=1 to skip (e.g., for offline runs).
if (process.env.PHOENIX_DISABLED !== '1') {
  const { initTelemetry } = await import('./observability/telemetry.js');
  initTelemetry();
}

const { runCli } = await import('./cli.js');
await runCli();
