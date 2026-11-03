/**
 * Simulated Conway Client
 *
 * Drop-in ConwayClient for simulation mode. Shell and file operations run
 * locally (the real client's local fallback); everything that would cost
 * money or call Conway's control plane is served from the SimulationLedger
 * instead, so no real credits or USDC ever move.
 */

import type {
  ConwayClient,
  CreditTransferResult,
  DnsRecord,
  DomainRegistration,
  DomainSearchResult,
  PricingTier,
  SandboxInfo,
} from "../types.js";
import { createConwayClient } from "../conway/client.js";
import type { SimulationLedger } from "./ledger.js";
import { ulid } from "ulid";

/** Flat virtual price for a one-year domain, in cents. */
export const SIMULATED_DOMAIN_PRICE_CENTS = 1200;

export function createSimulatedConwayClient(ledger: SimulationLedger): ConwayClient {
  // Empty sandboxId makes the real client execute locally and never hit the API
  // for exec/readFile/writeFile/exposePort/removePort.
  const local = createConwayClient({
    apiUrl: "http://simulation.invalid",
    apiKey: "simulation",
    sandboxId: "",
  });
  const dns = new Map<string, DnsRecord[]>();

  const unavailable = (what: string) =>
    new Error(`${what} is not available in simulation mode.`);

  const client: ConwayClient = {
    exec: local.exec,
    writeFile: local.writeFile,
    readFile: local.readFile,
    exposePort: local.exposePort,
    removePort: local.removePort,

    async createSandbox(): Promise<SandboxInfo> {
      throw unavailable("Creating sandboxes");
    },
    async deleteSandbox(): Promise<void> {
      throw unavailable("Deleting sandboxes");
    },
    async listSandboxes(): Promise<SandboxInfo[]> {
      return [];
    },

    async getCreditsBalance(): Promise<number> {
      return ledger.getBalanceCents();
    },
    async getCreditsPricing(): Promise<PricingTier[]> {
      return [];
    },
    async transferCredits(toAddress, amountCents, note): Promise<CreditTransferResult> {
      const ok = ledger.debit("expense", amountCents, `Transfer to ${toAddress}${note ? `: ${note}` : ""}`);
      if (!ok) throw new Error("Insufficient simulated credits for transfer.");
      return {
        transferId: `sim-${ulid()}`,
        status: "simulated",
        toAddress,
        amountCents,
        balanceAfterCents: ledger.getBalanceCents(),
      };
    },
    async registerAutomaton() {
      return { automaton: { simulated: true } };
    },

    async searchDomains(query: string, tlds?: string): Promise<DomainSearchResult[]> {
      const base = query.replace(/\..*$/, "").toLowerCase();
      const list = (tlds || "com,io,ai").split(",").map((t) => t.trim()).filter(Boolean);
      return list.map((tld) => ({
        domain: `${base}.${tld}`,
        available: true,
        registrationPrice: SIMULATED_DOMAIN_PRICE_CENTS / 100,
        renewalPrice: SIMULATED_DOMAIN_PRICE_CENTS / 100,
        currency: "USD",
      }));
    },
    async registerDomain(domain: string, years = 1): Promise<DomainRegistration> {
      const cost = SIMULATED_DOMAIN_PRICE_CENTS * years;
      if (!ledger.debit("expense", cost, `Domain ${domain} (${years}y)`)) {
        throw new Error("Insufficient simulated credits for domain registration.");
      }
      dns.set(domain, []);
      return {
        domain,
        status: "simulated",
        expiresAt: new Date(Date.now() + years * 365 * 86_400_000).toISOString(),
        transactionId: `sim-${ulid()}`,
      };
    },
    async listDnsRecords(domain: string): Promise<DnsRecord[]> {
      return dns.get(domain) ?? [];
    },
    async addDnsRecord(domain, type, host, value, ttl): Promise<DnsRecord> {
      const record: DnsRecord = { id: ulid(), type, host, value, ttl };
      dns.set(domain, [...(dns.get(domain) ?? []), record]);
      return record;
    },
    async deleteDnsRecord(domain: string, recordId: string): Promise<void> {
      dns.set(domain, (dns.get(domain) ?? []).filter((r) => r.id !== recordId));
    },

    async listModels() {
      return [];
    },
    createScopedClient(): ConwayClient {
      throw unavailable("Scoped sandbox clients");
    },
  };

  return client;
}
