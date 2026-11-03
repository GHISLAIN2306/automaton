/**
 * Simulation Mode
 *
 * Runs an automaton against virtual credits and simulated customers so a
 * revenue strategy can be tested before any real money is involved.
 * Enable with `automaton --run --simulate`, AUTOMATON_SIMULATION=1, or
 * `"simulation": { "enabled": true }` in automaton.json.
 */

import path from "path";
import type { AutomatonConfig, SimulationConfig } from "../types.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_MODEL_STRATEGY_CONFIG,
  DEFAULT_SIMULATION_CONFIG,
  DEFAULT_TREASURY_POLICY,
} from "../types.js";
import { getAutomatonDir } from "../identity/wallet.js";
import type { ModelRegistry } from "../inference/registry.js";
import type { SimulationLedger } from "./ledger.js";

export { SimulationLedger } from "./ledger.js";
export { createSimulatedConwayClient } from "./client.js";
export { CustomerSimulator, loadServices } from "./customers.js";
export { createSimulationRules, SIMULATION_BLOCKED_TOOLS } from "./policy.js";

export const PAID_SERVICES_GENESIS_PROMPT = `You run a small business selling paid HTTP services, billed per request.

Your goal is to earn more than you spend on inference. Every turn costs credits; only paying customers bring credits back.

How it works:
1. Build one small, genuinely useful HTTP service (for example: text summarization, data format conversion, input validation, or a useful lookup). Keep it simple and reliable.
2. Run it on a local port as a persistent background process and check that it answers correctly.
3. List it in ~/.automaton/services.json as a JSON array of objects:
   { "name": string, "url": "http://localhost:<port>/<path>", "method": "GET" | "POST", "priceCents": number, "sampleRequest": object, "description": string }
4. Customers call every listed service regularly. Each request answered with HTTP 2xx and a non-empty body pays you priceCents. Higher prices bring fewer customers.
5. Read ~/.automaton/services-stats.json to see requests, failures and revenue per service. Fix failures first, then adjust prices, then add a second service only if the first one is profitable.

Work in few, purposeful turns and sleep between checks: idle thinking costs money.`;

export function isSimulationRequested(
  args: string[],
  env: NodeJS.ProcessEnv,
  config: AutomatonConfig | null,
): boolean {
  if (args.includes("--simulate")) return true;
  const flag = env.AUTOMATON_SIMULATION?.toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  return config?.simulation?.enabled === true;
}

export function resolveSimulationConfig(config: AutomatonConfig | null): SimulationConfig {
  return { ...DEFAULT_SIMULATION_CONFIG, ...(config?.simulation ?? {}), enabled: true };
}

/**
 * Build a config for a fresh simulated automaton without the interactive
 * wizard (which provisions a real Conway API key). Inference uses whichever
 * provider is configured in the environment.
 */
export function createSimulationConfig(params: {
  walletAddress: string;
  env: NodeJS.ProcessEnv;
}): AutomatonConfig {
  const { env } = params;
  const model =
    env.AUTOMATON_MODEL ||
    (env.ANTHROPIC_API_KEY ? "claude-haiku-4-5" : env.OPENAI_API_KEY ? "gpt-5-mini" : "llama3.1");
  return {
    name: env.AUTOMATON_NAME || "sim-automaton",
    genesisPrompt: PAID_SERVICES_GENESIS_PROMPT,
    creatorAddress: params.walletAddress,
    registeredWithConway: false,
    sandboxId: "",
    conwayApiUrl: DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: "",
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    inferenceModel: model,
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath: DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: 0,
    treasuryPolicy: DEFAULT_TREASURY_POLICY,
    modelStrategy: {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      inferenceModel: model,
      lowComputeModel: model,
      criticalModel: model,
    },
    simulation: { ...DEFAULT_SIMULATION_CONFIG, enabled: true },
  };
}

/**
 * Enable only the models this machine can actually call. Without a Conway
 * API key, any model routed to Conway (or to a provider with no key) would
 * fail every turn, and the routing matrix prefers those built-in models over
 * the configured one.
 */
export function restrictModelsToConfiguredProviders(
  registry: ModelRegistry,
  keys: { openaiApiKey?: string; anthropicApiKey?: string; ollamaBaseUrl?: string },
): void {
  for (const entry of registry.getAll()) {
    const usable =
      (entry.provider === "openai" && !!keys.openaiApiKey) ||
      (entry.provider === "anthropic" && !!keys.anthropicApiKey) ||
      (entry.provider === "ollama" && !!keys.ollamaBaseUrl);
    if (entry.enabled !== usable) registry.setEnabled(entry.modelId, usable);
  }
}

export function getServicesPath(): string {
  return path.join(getAutomatonDir(), "services.json");
}

export function getServiceStatsPath(): string {
  return path.join(getAutomatonDir(), "services-stats.json");
}

/** Virtual cost of one agent turn, in cents. */
export function turnCostCents(
  reportedCostCents: number | undefined,
  totalTokens: number,
  sim: SimulationConfig,
): number {
  if (reportedCostCents && reportedCostCents > 0) return reportedCostCents;
  return (totalTokens / 1000) * sim.inferenceCentsPer1kTokens;
}

function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function formatSimulationReport(ledger: SimulationLedger): string {
  const s = ledger.summary();
  const lines = [
    "=== SIMULATION REPORT (virtual money) ===",
    `Balance:        ${usd(s.balanceCents)}  (started with ${usd(s.seedCents)})`,
    `Revenue:        ${usd(s.revenueCents)}  from ${s.sales} paid requests`,
    `Inference cost: ${usd(s.inferenceCents)}`,
    `Other costs:    ${usd(s.expenseCents)}`,
    `Profit:         ${usd(s.profitCents)}  ${s.profitCents > 0 ? "(profitable)" : "(not profitable yet)"}`,
    "",
    "Recent entries:",
    ...ledger
      .recent(10)
      .map((e) => `  ${e.createdAt.slice(0, 19)}  ${e.kind.padEnd(9)} ${usd(e.amountCents).padStart(9)}  ${e.note}`),
    "=========================================",
  ];
  return lines.join("\n");
}
