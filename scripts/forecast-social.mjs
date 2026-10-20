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
 * Usage: node scripts/forecast-social.mjs [--runs 5000] [--months 12] [--json]
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const RUNS = argValue("--runs", 5000);
const MONTHS = argValue("--months", 12);
const AS_JSON = args.includes("--json");

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

function runOnce(scenario, videoCost, random) {
  const quality = Math.exp(CHANNEL_SIGMA * normal(random));
  const videosPerMonth = COSTS.videosPerDay * 30;
  const fixed = COSTS.scheduler + COSTS.agent;
  const state = {};
  for (const key of Object.keys(PLATFORMS)) {
    state[key] = { followers: 0, monthlyViews: [], monetized: false, rejected: false, revenue: 0 };
  }

  let profit = 0;
  let lastRevenue = 0;
  let views12 = 0;
  for (let m = 1; m <= MONTHS; m++) {
    const median = scenario.medianViews * quality * Math.pow(1 + scenario.learning, m - 1);
    let monthRevenue = 0;
    for (const [key, p] of Object.entries(PLATFORMS)) {
      const s = state[key];
      // Audience lifts reach a little: +10% per 10k followers.
      const reach = 1 + s.followers / 100_000;
      let views = 0;
      for (let v = 0; v < videosPerMonth; v++) {
        views += median * reach * Math.exp(VIDEO_SIGMA * normal(random));
      }
      views = Math.round(views);
      s.monthlyViews.push(views);
      s.followers += views * p.followRate;
      if (m === MONTHS) views12 += views;

      if (s.monetized) {
        const paid = key === "tiktok" ? views * p.qualifiedShare : views;
        const revenue = (paid / 1000) * p.rpm;
        s.revenue += revenue;
        monthRevenue += revenue;
      } else if (!s.rejected) {
        const months = p.windowDays / 30;
        const recent = s.monthlyViews.slice(-months).reduce((a, b) => a + b, 0);
        if (s.followers >= p.followersNeeded && recent >= p.viewsNeeded(m)) {
          // Review happens; payouts start next month.
          if (random() < p.rejectionRate) s.rejected = true;
          else s.monetized = true;
        }
      }
    }
    profit += monthRevenue - fixed - videosPerMonth * videoCost;
    lastRevenue = monthRevenue;
  }
  return {
    profit,
    lastRevenue,
    views12,
    youtube: state.youtube.monetized,
    tiktok: state.tiktok.monetized,
    revenueYoutube: state.youtube.revenue,
    revenueTiktok: state.tiktok.revenue,
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
      tiktokShareOfRevenue: totalTiktok + totalYoutube > 0 ? totalTiktok / (totalTiktok + totalYoutube) : 0,
    });
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ runs: RUNS, months: MONTHS, platforms: PLATFORMS, costs: COSTS, results }, null, 2));
} else {
  const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(0)}`;
  const k = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`);
  console.log(`=== SOCIAL VIDEO FORECAST (virtual money, ${RUNS} runs x ${MONTHS} months) ===`);
  for (const r of results) {
    console.log(
      `\n${r.scenario} / ${r.production} videos (costs ${usd(r.monthlyCosts)}/month)\n` +
        `  12-month profit:   median ${usd(r.cumulativeProfit.median)}  [p10 ${usd(r.cumulativeProfit.p10)}, p90 ${usd(r.cumulativeProfit.p90)}]\n` +
        `  Month ${MONTHS} revenue: median ${usd(r.lastMonthRevenue.median)}  [p10 ${usd(r.lastMonthRevenue.p10)}, p90 ${usd(r.lastMonthRevenue.p90)}]\n` +
        `  Month ${MONTHS} views (both platforms): median ${k(r.lastMonthViews.median)}, p90 ${k(r.lastMonthViews.p90)}\n` +
        `  Monetized: TikTok ${(r.probTiktokMonetized * 100).toFixed(0)}%, YouTube ${(r.probYoutubeMonetized * 100).toFixed(0)}%\n` +
        `  P(profitable over 12 months): ${(r.probProfitable12m * 100).toFixed(0)}%`,
    );
  }
}
