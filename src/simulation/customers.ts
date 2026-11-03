/**
 * Simulated Customers
 *
 * Generates virtual demand for the paid services an automaton declares in
 * ~/.automaton/services.json. Each tick, every service receives a number of
 * requests that falls as its price rises; each request that gets a 2xx
 * response with a non-empty body is paid into the SimulationLedger.
 *
 * This is a deliberately simple demand model. It tells you whether the
 * agent can build and keep a working service running for less than it
 * costs in inference — not what real customers would pay.
 */

import fs from "fs";
import path from "path";
import type { SimulationLedger } from "./ledger.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("simulation.customers");

export interface ServiceListing {
  name: string;
  url: string;
  method?: "GET" | "POST";
  /** Price per request, in cents. */
  priceCents: number;
  /** JSON body sent with POST requests. */
  sampleRequest?: unknown;
  description?: string;
}

export interface ServiceStats {
  name: string;
  priceCents: number;
  requests: number;
  paid: number;
  failed: number;
  revenueCents: number;
  lastError?: string;
  lastTickAt?: string;
}

export interface CustomerSimulatorOptions {
  ledger: SimulationLedger;
  servicesPath: string;
  statsPath: string;
  /** Expected requests per tick for a service priced near zero. */
  baseRequestsPerTick?: number;
  /** Price (cents) at which demand drops to ~37% of base. Revenue peaks here. */
  referencePriceCents?: number;
  requestTimeoutMs?: number;
  random?: () => number;
  fetchImpl?: typeof fetch;
}

const MAX_SERVICES = 20;

export function loadServices(servicesPath: string): ServiceListing[] {
  if (!fs.existsSync(servicesPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(servicesPath, "utf-8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.services) ? raw.services : [];
    return list
      .filter(
        (s: any) =>
          s &&
          typeof s.name === "string" &&
          typeof s.url === "string" &&
          typeof s.priceCents === "number" &&
          Number.isFinite(s.priceCents) &&
          s.priceCents > 0,
      )
      .filter((s: ServiceListing) => isLocalUrl(s.url))
      .slice(0, MAX_SERVICES);
  } catch (err: any) {
    logger.warn(`Could not parse ${servicesPath}: ${err.message}`);
    return [];
  }
}

/** Simulated customers only call services running on this machine. */
export function isLocalUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      (protocol === "http:" || protocol === "https:") &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/** Draw a Poisson-distributed count (Knuth's method; fine for small means). */
function poisson(mean: number, random: () => number): number {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= random();
  } while (p > limit && k < 1000);
  return k - 1;
}

export function expectedRequests(priceCents: number, base: number, reference: number): number {
  return base * Math.exp(-priceCents / reference);
}

export class CustomerSimulator {
  private readonly stats = new Map<string, ServiceStats>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly base: number;
  private readonly reference: number;
  private readonly timeoutMs: number;
  private readonly random: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CustomerSimulatorOptions) {
    this.base = options.baseRequestsPerTick ?? 5;
    this.reference = options.referencePriceCents ?? 5;
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
    this.random = options.random ?? Math.random;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStats(): ServiceStats[] {
    return [...this.stats.values()];
  }

  /** Run one round of simulated demand. Returns cents earned this tick. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let earned = 0;
    try {
      const services = loadServices(this.options.servicesPath);
      for (const service of services) {
        earned += await this.serve(service);
      }
      this.writeStats();
    } finally {
      this.running = false;
    }
    return earned;
  }

  private async serve(service: ServiceListing): Promise<number> {
    const stats = this.stats.get(service.name) ?? {
      name: service.name,
      priceCents: service.priceCents,
      requests: 0,
      paid: 0,
      failed: 0,
      revenueCents: 0,
    };
    stats.priceCents = service.priceCents;
    stats.lastTickAt = new Date().toISOString();
    this.stats.set(service.name, stats);

    const count = poisson(expectedRequests(service.priceCents, this.base, this.reference), this.random);
    let earned = 0;
    for (let i = 0; i < count; i++) {
      stats.requests++;
      const error = await this.callService(service);
      if (error) {
        stats.failed++;
        stats.lastError = error;
        continue;
      }
      stats.paid++;
      stats.revenueCents += service.priceCents;
      earned += service.priceCents;
      this.options.ledger.credit(service.priceCents, `Sale: ${service.name}`);
    }
    return earned;
  }

  private async callService(service: ServiceListing): Promise<string | null> {
    const method = service.method ?? (service.sampleRequest !== undefined ? "POST" : "GET");
    try {
      const resp = await this.fetchImpl(service.url, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify(service.sampleRequest ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!resp.ok) return `HTTP ${resp.status}`;
      const body = await resp.text();
      if (!body.trim()) return "Empty response";
      return null;
    } catch (err: any) {
      return err?.message || String(err);
    }
  }

  private writeStats(): void {
    try {
      fs.mkdirSync(path.dirname(this.options.statsPath), { recursive: true });
      fs.writeFileSync(
        this.options.statsPath,
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            ledger: this.options.ledger.summary(),
            services: this.getStats(),
          },
          null,
          2,
        ),
      );
    } catch (err: any) {
      logger.warn(`Could not write service stats: ${err.message}`);
    }
  }
}
