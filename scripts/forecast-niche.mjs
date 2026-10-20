#!/usr/bin/env node
/**
 * Niche revenue forecast (virtual money only)
 *
 * Monte Carlo estimate of what a "content to agent-ready text" service
 * (audio transcription, web page -> Markdown, PDF -> Markdown) could earn
 * over 12 months, sold on the x402 Bazaar and on Apify Store.
 *
 * Demand is calibrated on public 30-day Bazaar data (Oct 2026):
 *   - transcription leader: 17 paying wallets, 54 calls, $0.40/call
 *   - web -> Markdown leader: 21 wallets, 101 calls, $0.02/call
 *   - PDF -> Markdown: ~5-7 paying wallets
 *   - 77% of all listings have <= 2 payers in 30 days
 * Apify demand has no public per-actor revenue data: those figures are
 * assumptions and are labelled as such in the report.
 *
 * Usage: node scripts/forecast-niche.mjs [--runs 5000] [--months 12] [--sigma 0.5]
 *        [--transcribe-price 0.02] [--json]
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const RUNS = argValue("--runs", 5000);
const MONTHS = argValue("--months", 12);
const AS_JSON = args.includes("--json");
// Spread of each run's demand around its scenario (lognormal sigma). Real
// demand for a new listing is far more uncertain than Poisson noise alone.
const DEMAND_SIGMA = argValue("--sigma", 0.5);

// Prices we would charge (USD).
const PRICES = {
  transcribePerMinute: argValue("--transcribe-price", 0.02),
  read: 0.005,
  pdf: 0.01,
};

// Costs (USD).
const COSTS = {
  server: 12, // small VPS per month
  domain: 1, // per month
  transcribePerMinute: 0.006, // Whisper list price; gpt-4o-mini-transcribe is 0.003
  perLightCall: 0.0002, // bandwidth/CPU for read and pdf
  facilitatorFree: 1000, // CDP facilitator: free settlements per month
  facilitatorFee: 0.001, // then per settlement
  apifyShare: 0.8, // developer share of Apify pay-per-event revenue
  apifyComputePerRun: 0.01, // platform compute deducted per run
};

// Agent running cost per month: economy = cheap model, slow heartbeat.
const AGENT_MODES = {
  econome: 8,
  normal: 45,
};

/**
 * Demand at maturity, per month. Payers ramp linearly to this level over
 * `rampMonths`, then the whole market grows by `growth` per month.
 */
const SCENARIOS = {
  prudent: {
    label: "Prudent",
    rampMonths: 6,
    growth: 0,
    x402: {
      transcribe: { payers: 3, callsPerPayer: 3, minutesPerCall: 6 },
      read: { payers: 3, callsPerPayer: 5 },
      pdf: { payers: 2, callsPerPayer: 4 },
    },
    apify: { payingUsers: 2, runsPerUser: 15, minutesPerRun: 10 },
  },
  moyen: {
    label: "Moyen",
    rampMonths: 6,
    growth: 0.03,
    x402: {
      transcribe: { payers: 12, callsPerPayer: 3, minutesPerCall: 6 },
      read: { payers: 15, callsPerPayer: 5 },
      pdf: { payers: 6, callsPerPayer: 4 },
    },
    apify: { payingUsers: 10, runsPerUser: 15, minutesPerRun: 10 },
  },
  optimiste: {
    label: "Optimiste",
    rampMonths: 5,
    growth: 0.1,
    x402: {
      transcribe: { payers: 40, callsPerPayer: 4, minutesPerCall: 8 },
      read: { payers: 50, callsPerPayer: 8 },
      pdf: { payers: 20, callsPerPayer: 5 },
    },
    apify: { payingUsers: 30, runsPerUser: 20, minutesPerRun: 10 },
  },
};

// Seeded PRNG (mulberry32) so runs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(mean, random) {
  if (mean <= 0) return 0;
  if (mean > 50) {
    // Normal approximation for large means.
    const u = 1 - random();
    const v = random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0, Math.round(mean + z * Math.sqrt(mean)));
  }
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= random();
  } while (p > limit);
  return k - 1;
}

/** Sum of `n` exponential draws with the given mean (audio lengths). */
function totalMinutes(n, mean, random) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += -Math.log(1 - random()) * mean;
  return sum;
}

function demandFactor(month, scenario) {
  const ramp = Math.min(1, month / scenario.rampMonths);
  const growth = Math.pow(1 + scenario.growth, Math.max(0, month - scenario.rampMonths));
  return ramp * growth;
}

/** Lognormal multiplier with median 1. */
function demandMultiplier(random) {
  const u = 1 - random();
  const v = random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.exp(DEMAND_SIGMA * z);
}

function simulateMonth(month, scenario, random, multiplier) {
  const f = demandFactor(month, scenario) * multiplier;
  const x = scenario.x402;

  // x402: each payer makes a Poisson number of calls (at least one).
  const calls = (d) => {
    const payers = poisson(d.payers * f, random);
    let n = 0;
    for (let i = 0; i < payers; i++) n += 1 + poisson(d.callsPerPayer - 1, random);
    return n;
  };
  const tCalls = calls(x.transcribe);
  const tMinutes = totalMinutes(tCalls, x.transcribe.minutesPerCall, random);
  const rCalls = calls(x.read);
  const pCalls = calls(x.pdf);

  const x402Revenue =
    tMinutes * PRICES.transcribePerMinute + rCalls * PRICES.read + pCalls * PRICES.pdf;
  const settlements = tCalls + rCalls + pCalls;
  const facilitator = Math.max(0, settlements - COSTS.facilitatorFree) * COSTS.facilitatorFee;

  // Apify: paying users run the transcription actor.
  const a = scenario.apify;
  const users = poisson(a.payingUsers * f, random);
  let runs = 0;
  for (let i = 0; i < users; i++) runs += 1 + poisson(a.runsPerUser - 1, random);
  const aMinutes = totalMinutes(runs, a.minutesPerRun, random);
  const apifyGross = aMinutes * PRICES.transcribePerMinute;
  const apifyRevenue = apifyGross * COSTS.apifyShare - runs * COSTS.apifyComputePerRun;

  const variableCosts =
    (tMinutes + aMinutes) * COSTS.transcribePerMinute +
    (rCalls + pCalls) * COSTS.perLightCall +
    facilitator;

  return {
    x402Revenue,
    apifyRevenue,
    revenue: x402Revenue + apifyRevenue,
    variableCosts,
    calls: settlements + runs,
    minutes: tMinutes + aMinutes,
  };
}

function percentile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i];
}

function runScenario(key, agentMode) {
  const scenario = SCENARIOS[key];
  const fixed = COSTS.server + COSTS.domain + AGENT_MODES[agentMode];
  const cumulative = [];
  const lastMonthRevenue = [];
  const lastMonthProfit = [];
  const x402Share = [];
  const breakeven = [];
  const monthlyRevenueSum = new Array(MONTHS).fill(0);

  for (let run = 0; run < RUNS; run++) {
    const random = rng(1000 + run);
    const multiplier = demandMultiplier(random);
    let total = 0;
    let firstProfitable = null;
    let lastRev = 0;
    let lastProfit = 0;
    let x402Total = 0;
    let revTotal = 0;
    for (let m = 1; m <= MONTHS; m++) {
      const r = simulateMonth(m, scenario, random, multiplier);
      const profit = r.revenue - r.variableCosts - fixed;
      total += profit;
      monthlyRevenueSum[m - 1] += r.revenue;
      x402Total += r.x402Revenue;
      revTotal += r.revenue;
      if (firstProfitable === null && profit > 0) firstProfitable = m;
      lastRev = r.revenue;
      lastProfit = profit;
    }
    cumulative.push(total);
    lastMonthRevenue.push(lastRev);
    lastMonthProfit.push(lastProfit);
    x402Share.push(revTotal > 0 ? x402Total / revTotal : 0);
    breakeven.push(firstProfitable);
  }

  const sort = (a) => [...a].sort((p, q) => p - q);
  const cum = sort(cumulative);
  const rev = sort(lastMonthRevenue);
  const prof = sort(lastMonthProfit);
  const reached = breakeven.filter((m) => m !== null);
  return {
    scenario: scenario.label,
    agentMode,
    fixedCostsPerMonth: fixed,
    cumulativeProfit: { p10: percentile(cum, 0.1), median: percentile(cum, 0.5), p90: percentile(cum, 0.9) },
    lastMonthRevenue: { p10: percentile(rev, 0.1), median: percentile(rev, 0.5), p90: percentile(rev, 0.9) },
    lastMonthProfit: { p10: percentile(prof, 0.1), median: percentile(prof, 0.5), p90: percentile(prof, 0.9) },
    probProfitable12m: cumulative.filter((v) => v > 0).length / RUNS,
    probMonthlyBreakeven: reached.length / RUNS,
    medianBreakevenMonth: reached.length ? sort(reached)[Math.floor(reached.length / 2)] : null,
    x402ShareOfRevenue: x402Share.reduce((s, v) => s + v, 0) / RUNS,
    avgMonthlyRevenue: monthlyRevenueSum.map((v) => v / RUNS),
  };
}

const results = [];
for (const key of Object.keys(SCENARIOS)) {
  for (const mode of Object.keys(AGENT_MODES)) results.push(runScenario(key, mode));
}

if (AS_JSON) {
  console.log(JSON.stringify({ runs: RUNS, months: MONTHS, prices: PRICES, costs: COSTS, agentModes: AGENT_MODES, results }, null, 2));
} else {
  const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
  console.log(`=== NICHE FORECAST (virtual money, ${RUNS} runs x ${MONTHS} months, transcription $${PRICES.transcribePerMinute}/min) ===`);
  for (const r of results) {
    console.log(
      `\n${r.scenario} / agent ${r.agentMode} (fixed ${usd(r.fixedCostsPerMonth)}/month)\n` +
        `  12-month profit:   median ${usd(r.cumulativeProfit.median)}  [p10 ${usd(r.cumulativeProfit.p10)}, p90 ${usd(r.cumulativeProfit.p90)}]\n` +
        `  Month ${MONTHS} revenue: median ${usd(r.lastMonthRevenue.median)}  [p10 ${usd(r.lastMonthRevenue.p10)}, p90 ${usd(r.lastMonthRevenue.p90)}]\n` +
        `  Month ${MONTHS} profit:  median ${usd(r.lastMonthProfit.median)}\n` +
        `  P(profitable over 12 months): ${(r.probProfitable12m * 100).toFixed(0)}%\n` +
        `  Runs with at least one profitable month: ${(r.probMonthlyBreakeven * 100).toFixed(0)}%` +
        (r.medianBreakevenMonth ? ` (median first: month ${r.medianBreakevenMonth})\n` : "\n") +
        `  Share of revenue from x402: ${(r.x402ShareOfRevenue * 100).toFixed(0)}%`,
    );
  }
}
