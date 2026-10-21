/**
 * Simulation mode: virtual ledger, simulated Conway client,
 * simulated customers and the real-funds policy guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { createTestDb } from "./mocks.js";
import { SimulationLedger } from "../simulation/ledger.js";
import { createSimulatedConwayClient, SIMULATED_DOMAIN_PRICE_CENTS } from "../simulation/client.js";
import { CustomerSimulator, loadServices, expectedRequests, isLocalUrl } from "../simulation/customers.js";
import { createSimulationRules, SIMULATION_BLOCKED_TOOLS } from "../simulation/policy.js";
import {
  isSimulationRequested,
  createSimulationConfig,
  turnCostCents,
  formatSimulationReport,
} from "../simulation/index.js";
import { DEFAULT_SIMULATION_CONFIG } from "../types.js";
import type { AutomatonConfig, PolicyRequest } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "automaton-sim-"));
}

describe("SimulationLedger", () => {
  let ledger: SimulationLedger;
  beforeEach(() => {
    ledger = new SimulationLedger(createTestDb().raw);
  });

  it("seeds the starting balance only once", () => {
    ledger.seed(500);
    ledger.seed(500);
    expect(ledger.getBalanceCents()).toBe(500);
  });

  it("tracks revenue, costs and profit", () => {
    ledger.seed(500);
    ledger.credit(30, "Sale");
    ledger.charge("inference", 10, "Turn");
    expect(ledger.debit("expense", 5, "Domain")).toBe(true);
    const s = ledger.summary();
    expect(s.balanceCents).toBe(515);
    expect(s.revenueCents).toBe(30);
    expect(s.inferenceCents).toBe(10);
    expect(s.expenseCents).toBe(5);
    expect(s.profitCents).toBe(15);
    expect(s.sales).toBe(1);
  });

  it("refuses debits beyond the balance and clamps charges at zero", () => {
    ledger.seed(10);
    expect(ledger.debit("expense", 20, "Too expensive")).toBe(false);
    expect(ledger.getBalanceCents()).toBe(10);
    ledger.charge("inference", 50, "Big turn");
    expect(ledger.getBalanceCents()).toBe(0);
  });

  it("keeps fractional inference costs free of float noise", () => {
    ledger.seed(500);
    for (let i = 0; i < 3; i++) ledger.charge("inference", 1.6, "Turn");
    const s = ledger.summary();
    expect(s.inferenceCents).toBe(4.8);
    expect(s.balanceCents).toBe(495.2);
  });

  it("formats a readable report", () => {
    ledger.seed(500);
    ledger.credit(25, "Sale: echo");
    expect(formatSimulationReport(ledger)).toContain("Revenue:        $0.25");
  });
});

describe("Simulated Conway client", () => {
  it("serves credits from the ledger and never creates sandboxes", async () => {
    const ledger = new SimulationLedger(createTestDb().raw);
    ledger.seed(5000);
    const client = createSimulatedConwayClient(ledger);
    expect(await client.getCreditsBalance()).toBe(5000);
    await expect(client.createSandbox({})).rejects.toThrow(/simulation/);
  });

  it("charges domain registrations and transfers to the ledger", async () => {
    const ledger = new SimulationLedger(createTestDb().raw);
    ledger.seed(5000);
    const client = createSimulatedConwayClient(ledger);
    await client.registerDomain("example.com");
    const transfer = await client.transferCredits("0xabc", 100);
    expect(transfer.status).toBe("simulated");
    expect(await client.getCreditsBalance()).toBe(5000 - SIMULATED_DOMAIN_PRICE_CENTS - 100);
  });

  it("refuses transfers the virtual balance cannot cover", async () => {
    const ledger = new SimulationLedger(createTestDb().raw);
    ledger.seed(50);
    const client = createSimulatedConwayClient(ledger);
    await expect(client.transferCredits("0xabc", 100)).rejects.toThrow(/Insufficient/);
  });

  it("executes shell commands locally", async () => {
    const ledger = new SimulationLedger(createTestDb().raw);
    const client = createSimulatedConwayClient(ledger);
    const result = await client.exec("echo hello");
    expect(result.stdout.trim()).toBe("hello");
  });
});

describe("Simulation policy", () => {
  it("denies every tool that can move real funds", () => {
    const [rule] = createSimulationRules();
    expect(rule.appliesTo).toEqual({ by: "name", names: [...SIMULATION_BLOCKED_TOOLS] });
    for (const name of ["topup_credits", "x402_fetch", "fund_child", "register_erc8004"]) {
      const result = rule.evaluate({ tool: { name }, args: {} } as unknown as PolicyRequest);
      expect(result?.action).toBe("deny");
      expect(result?.reasonCode).toBe("SIMULATION_MODE");
    }
  });
});

describe("Simulated customers", () => {
  it("only accepts valid, local, priced services", () => {
    const dir = tmpDir();
    const file = path.join(dir, "services.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { name: "ok", url: "http://localhost:8080/x", priceCents: 2 },
        { name: "remote", url: "https://example.com/x", priceCents: 2 },
        { name: "free", url: "http://localhost:8080/y", priceCents: 0 },
        { name: "noprice", url: "http://localhost:8080/z" },
      ]),
    );
    expect(loadServices(file).map((s) => s.name)).toEqual(["ok"]);
    expect(loadServices(path.join(dir, "missing.json"))).toEqual([]);
    expect(isLocalUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalUrl("http://evil.com")).toBe(false);
  });

  it("lowers demand as price rises", () => {
    expect(expectedRequests(1, 5, 5)).toBeGreaterThan(expectedRequests(20, 5, 5));
  });

  it("pays for successful requests and counts failures", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.end(JSON.stringify({ result: "done" }));
      } else {
        res.statusCode = 500;
        res.end("boom");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const dir = tmpDir();
      const servicesPath = path.join(dir, "services.json");
      const statsPath = path.join(dir, "stats.json");
      fs.writeFileSync(
        servicesPath,
        JSON.stringify([
          { name: "good", url: `http://127.0.0.1:${port}/ok`, priceCents: 3 },
          { name: "broken", url: `http://127.0.0.1:${port}/fail`, priceCents: 3 },
        ]),
      );
      const ledger = new SimulationLedger(createTestDb().raw);
      // random() = 0.5 with mean 5*exp(-3/5) ≈ 2.74 draws a fixed count per service.
      const sim = new CustomerSimulator({ ledger, servicesPath, statsPath, random: () => 0.5 });
      const earned = await sim.tick();

      const stats = sim.getStats();
      const good = stats.find((s) => s.name === "good")!;
      const broken = stats.find((s) => s.name === "broken")!;
      expect(good.paid).toBeGreaterThan(0);
      expect(good.failed).toBe(0);
      expect(broken.paid).toBe(0);
      expect(broken.failed).toBe(broken.requests);
      expect(broken.lastError).toBe("HTTP 500");
      expect(earned).toBe(good.paid * 3);
      expect(ledger.summary().revenueCents).toBe(earned);
      expect(JSON.parse(fs.readFileSync(statsPath, "utf-8")).services).toHaveLength(2);
    } finally {
      server.close();
    }
  });
});

describe("Simulation config", () => {
  it("is requested by flag, env var or config", () => {
    expect(isSimulationRequested(["--run", "--simulate"], {}, null)).toBe(true);
    expect(isSimulationRequested(["--run"], { AUTOMATON_SIMULATION: "1" }, null)).toBe(true);
    expect(
      isSimulationRequested(["--run"], {}, { simulation: { enabled: true } } as AutomatonConfig),
    ).toBe(true);
    expect(isSimulationRequested(["--run"], {}, null)).toBe(false);
  });

  it("builds a local config that uses the configured provider", () => {
    const config = createSimulationConfig({
      walletAddress: "0x1234",
      env: { OLLAMA_BASE_URL: "http://localhost:11434", AUTOMATON_MODEL: "qwen3:8b" },
    });
    expect(config.sandboxId).toBe("");
    expect(config.simulation?.enabled).toBe(true);
    expect(config.inferenceModel).toBe("qwen3:8b");
    expect(config.modelStrategy?.criticalModel).toBe("qwen3:8b");
    expect(config.maxChildren).toBe(0);
  });

  it("charges reported cost, or a token estimate when the provider reports none", () => {
    expect(turnCostCents(4, 1000, DEFAULT_SIMULATION_CONFIG)).toBe(4);
    expect(turnCostCents(0, 2000, DEFAULT_SIMULATION_CONFIG)).toBe(1);
  });
});
