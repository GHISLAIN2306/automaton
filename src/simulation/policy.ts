/**
 * Simulation Policy Rules
 *
 * In simulation mode, deny every tool that can move real funds or reach
 * real infrastructure on its own (USDC payments, on-chain transactions,
 * sandbox creation, child funding). The simulated Conway client covers the
 * rest; these rules are the second line of defense.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../types.js";

export const SIMULATION_BLOCKED_TOOLS = [
  "topup_credits",
  "x402_fetch",
  "register_erc8004",
  "spawn_child",
  "start_child",
  "fund_child",
  "create_sandbox",
  "delete_sandbox",
] as const;

export function createSimulationRules(): PolicyRule[] {
  return [
    {
      id: "simulation.block_real_funds",
      description: "Deny tools that spend real funds or create real infrastructure in simulation mode",
      priority: 50,
      appliesTo: { by: "name", names: [...SIMULATION_BLOCKED_TOOLS] },
      evaluate(request: PolicyRequest): PolicyRuleResult {
        return {
          rule: "simulation.block_real_funds",
          action: "deny",
          reasonCode: "SIMULATION_MODE",
          humanMessage:
            `${request.tool.name} is disabled in simulation mode: it would spend real funds or create real infrastructure. ` +
            "Earn simulated revenue by running paid services listed in ~/.automaton/services.json instead.",
        };
      },
    },
  ];
}
