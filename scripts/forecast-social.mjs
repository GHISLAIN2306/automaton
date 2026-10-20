#!/usr/bin/env node
/**
 * Social video revenue forecast (virtual money only)
 *
 * Monte Carlo estimate of what an agent posting AI-made short videos to
 * TikTok and YouTube Shorts could earn from platform payouts over 12 months,
 * starting November 2026. Sponsorships and affiliate income are left out.
 *
 * Platform rules (Oct 2026):
 *   - YouTube Partner Program: 1,000 subscribers and 10M Shorts views in 90
 *     days; 20M for new applicants from 1 Feb 2027 (month 4 here). Shorts
 *     RPM about $0.02-0.20 per 1,000 views (third-party estimates).
 *   - TikTok Creator Rewards (France eligible): 10,000 followers and 100,000
 *     views in 30 days, videos over one minute. RPM about $0.40-1.00 per
 *     1,000 qualified views (third-party estimates).
 *   - Mass-produced content can be refused or demonetized (YouTube
 *     "inauthentic content" policy), modelled as a review rejection rate.
 * Views per video and follower conversion are assumptions, not sourced data.
 *
 * Usage: node scripts/forecast-social.mjs [--runs 5000] [--months 12] [--replicate 3] [--json]
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const RUNS = argValue("--runs", 5000);
const MONTHS = argValue("--months", 12);
const AS_JSON = args.includes("--json");
// Maximum number of child accounts the agent may spawn (0 = no replication).
const REPLICATE = argValue("--replicate", 0);

const PLATFORMS = {
  youtube: {
    followersNeeded: 1000,
    windowDays: 90,
    viewsNeeded: (month) => (month >= 4 ? 20_000_000 : 10_000_000),
    rpm: 0.06, // per 1,000 views, creator share
    followRate: 0.001, // subscribers per view
    rejectionRate: 0.3, // refused or demonetized as mass-produced
  },
  tiktok: {
    followersNeeded: 10_000,
    windowDays: 30,
    viewsNeeded: () => 100_000,
    rpm: 0.5, // per 1,000 qualified views
    qualifiedShare: 0.6, // views that count for Creator Rewards
    followRate: 0.003,
    rejectionRate: 0.2,
  },
};

// Monthly costs (USD).
const COSTS = {
  videosPerDay: 3, // each video is posted to both platforms
  costPerVideo: { cheap: 0.5, ai: 3 }, // images + TTS, or AI clips (~$0.03-0.05/s for 60 s)
  scheduler: 29, // posting tool with an audited TikTok app
  extraAccount: 10, // scheduler cost of each additional account
  agent: 20, // economy model, more turns than a plain API service
};

/**
 * Median views of one video at launch. Each run draws its own channel
 * quality around it; each video then varies a lot around the channel.
 */
const SCENARIOS = {
  prudent: { label: "Prudent", medianViews: 150, learning: 0.05 },
  moyen: { label: "Moyen", medianViews: 600, learning: 0.12 },
  optimiste: { label: "Optimiste", medianViews: 2500, learning: 0.2 },
};
const CHANNEL_SIGMA = 1.0;
const VIDEO_SIGMA = 1.6;

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

function normal(random) {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/** One account in one niche. Steps month by month. */
class Channel {
  constructor(scenario, videoCost, quality, random, startMonth) {
    this.scenario = scenario;
    this.videoCost = videoCost;
    this.quality = quality;
    this.random = random;
    this.startMonth = startMonth;
    this.active = true;
    this.history = []; // monthly profit
    this.views = 0;
    this.state = {};
    for (const key of Object.keys(PLATFORMS)) {
      this.state[key] = { followers: 0, monthlyViews: [], monetized: false, rejected: false, revenue: 0 };
    }
  }

  get monthlyCost() {
    return COSTS.agent + COSTS.videosPerDay * 30 * this.videoCost + (this.startMonth > 1 ? COSTS.extraAccount : COSTS.scheduler);
  }

  step(month) {
    const random = this.random;
    const age = month - this.startMonth + 1;
    const videosPerMonth = COSTS.videosPerDay * 30;
    const median = this.scenario.medianViews * this.quality * Math.pow(1 + this.scenario.learning, age - 1);
    let revenue = 0;
    this.views = 0;
    for (const [key, p] of Object.entries(PLATFORMS)) {
      const s = this.state[key];
      // Audience lifts reach a little: +10% per 10k followers.
      const reach = 1 + s.followers / 100_000;
      let views = 0;
      for (let v = 0; v < videosPerMonth; v++) {
        views += median * reach * Math.exp(VIDEO_SIGMA * normal(random));
      }
      views = Math.round(views);
      s.monthlyViews.push(views);
      s.followers += views * p.followRate;
      this.views += views;

      if (s.monetized) {
        const paid = key === "tiktok" ? views * p.qualifiedShare : views;
        const r = (paid / 1000) * p.rpm;
        s.revenue += r;
        revenue += r;
      } else if (!s.rejected) {
        const months = p.windowDays / 30;
        const recent = s.monthlyViews.slice(-months).reduce((a, b) => a + b, 0);
        if (s.followers >= p.followersNeeded && recent >= p.viewsNeeded(month)) {
          // Review happens; payouts start next month.
          if (random() < p.rejectionRate) s.rejected = true;
          else s.monetized = true;
        }
      }
    }
    const profit = revenue - this.monthlyCost;
    this.history.push(profit);
    return { revenue, profit };
  }
}

/**
 * Replication rule (only with --replicate N): once the network has been
 * profitable for two months in a row, spawn one new account in a new niche,
 * at most one per month and N in total. A child's quality is only partly
 * inherited (know-how transfers, audience does not). A child still losing
 * money at age 4 months is shut down.
 */
function runOnce(scenario, videoCost, random) {
  const quality = Math.exp(CHANNEL_SIGMA * normal(random));
  const channels = [new Channel(scenario, videoCost, quality, random, 1)];
  let profit = 0;
  let lastRevenue = 0;
  let views12 = 0;
  let peakCost = 0;
  let streak = 0;
  for (let m = 1; m <= MONTHS; m++) {
    let monthProfit = 0;
    let monthRevenue = 0;
    let monthCost = 0;
    for (const c of channels) {
      if (!c.active) continue;
      const r = c.step(m);
      monthProfit += r.profit;
      monthRevenue += r.revenue;
      monthCost += c.monthlyCost;
      if (m === MONTHS) views12 += c.views;
      const age = m - c.startMonth + 1;
      if (c !== channels[0] && age >= 4 && r.profit < 0) c.active = false;
    }
    profit += monthProfit;
    lastRevenue = monthRevenue;
    peakCost = Math.max(peakCost, monthCost);
    streak = monthProfit > 0 ? streak + 1 : 0;
    if (REPLICATE > 0 && streak >= 2 && channels.length - 1 < REPLICATE && m < MONTHS) {
      const childQuality = Math.exp(0.5 * Math.log(quality) + Math.sqrt(1 - 0.25) * CHANNEL_SIGMA * normal(random));
      channels.push(new Channel(scenario, videoCost, childQuality, random, m + 1));
    }
  }
  const main = channels[0].state;
  return {
    profit,
    lastRevenue,
    views12,
    peakCost,
    children: channels.length - 1,
    youtube: main.youtube.monetized,
    tiktok: main.tiktok.monetized,
    revenueYoutube: channels.reduce((s, c) => s + c.state.youtube.revenue, 0),
    revenueTiktok: channels.reduce((s, c) => s + c.state.tiktok.revenue, 0),
  };
}

const results = [];
for (const [key, scenario] of Object.entries(SCENARIOS)) {
  for (const [costKey, videoCost] of Object.entries(COSTS.costPerVideo)) {
    const runs = [];
    for (let r = 0; r < RUNS; r++) runs.push(runOnce(scenario, videoCost, rng(7000 + r)));
    const sort = (f) => runs.map(f).sort((a, b) => a - b);
    const profits = sort((r) => r.profit);
    const revenue = sort((r) => r.lastRevenue);
    const views = sort((r) => r.views12);
    const totalTiktok = runs.reduce((s, r) => s + r.revenueTiktok, 0);
    const totalYoutube = runs.reduce((s, r) => s + r.revenueYoutube, 0);
    results.push({
      scenario: scenario.label,
      production: costKey,
      monthlyCosts: COSTS.scheduler + COSTS.agent + COSTS.videosPerDay * 30 * videoCost,
      cumulativeProfit: { p10: percentile(profits, 0.1), median: percentile(profits, 0.5), p90: percentile(profits, 0.9) },
      lastMonthRevenue: { p10: percentile(revenue, 0.1), median: percentile(revenue, 0.5), p90: percentile(revenue, 0.9) },
      lastMonthViews: { median: percentile(views, 0.5), p90: percentile(views, 0.9) },
      probTiktokMonetized: runs.filter((r) => r.tiktok).length / RUNS,
      probYoutubeMonetized: runs.filter((r) => r.youtube).length / RUNS,
      probProfitable12m: runs.filter((r) => r.profit > 0).length / RUNS,
      avgChildren: runs.reduce((s, r) => s + r.children, 0) / RUNS,
      peakMonthlyCost: { median: percentile(sort((r) => r.peakCost), 0.5), p90: percentile(sort((r) => r.peakCost), 0.9) },
      tiktokShareOfRevenue: totalTiktok + totalYoutube > 0 ? totalTiktok / (totalTiktok + totalYoutube) : 0,
    });
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ runs: RUNS, months: MONTHS, platforms: PLATFORMS, costs: COSTS, results }, null, 2));
} else {
  const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(0)}`;
  const k = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`);
  console.log(`=== SOCIAL VIDEO FORECAST (virtual money, ${RUNS} runs x ${MONTHS} months, max ${REPLICATE} child accounts) ===`);
  for (const r of results) {
    console.log(
      `\n${r.scenario} / ${r.production} videos (costs ${usd(r.monthlyCosts)}/month)\n` +
        `  12-month profit:   median ${usd(r.cumulativeProfit.median)}  [p10 ${usd(r.cumulativeProfit.p10)}, p90 ${usd(r.cumulativeProfit.p90)}]\n` +
        `  Month ${MONTHS} revenue: median ${usd(r.lastMonthRevenue.median)}  [p10 ${usd(r.lastMonthRevenue.p10)}, p90 ${usd(r.lastMonthRevenue.p90)}]\n` +
        `  Month ${MONTHS} views (both platforms): median ${k(r.lastMonthViews.median)}, p90 ${k(r.lastMonthViews.p90)}\n` +
        `  Monetized: TikTok ${(r.probTiktokMonetized * 100).toFixed(0)}%, YouTube ${(r.probYoutubeMonetized * 100).toFixed(0)}%\n` +
        `  P(profitable over 12 months): ${(r.probProfitable12m * 100).toFixed(0)}%` +
        (REPLICATE > 0
          ? `\n  Child accounts spawned (avg): ${r.avgChildren.toFixed(2)}, peak monthly cost: median ${usd(r.peakMonthlyCost.median)}, p90 ${usd(r.peakMonthlyCost.p90)}`
          : ""),
    );
  }
}
