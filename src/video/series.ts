/**
 * Series Page ("lien en bio")
 *
 * A profile has a single link, but each DramaCPS series has its own drama
 * URL. Every series posted gets a short number, kept in
 * content/clips/series.json, and a public page lists them newest first:
 * "Série n° 12 → regarder la suite". Captions point to that number.
 */

import fs from "fs";
import path from "path";

export interface SeriesEntry {
  number: number;
  title: string;
  url: string;
  dramaId?: string;
  addedAt: string;
}

function registryFile(clipsDir: string): string {
  return path.join(clipsDir, "series.json");
}

export function loadSeries(clipsDir: string): SeriesEntry[] {
  const file = registryFile(clipsDir);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as SeriesEntry[]) : [];
}

/** Number of the series behind a drama URL, adding it on first use. */
export function registerSeries(clipsDir: string, series: { title: string; url: string; dramaId?: string }, now = new Date()): number {
  const all = loadSeries(clipsDir);
  const known = all.find((s) => s.url === series.url || (series.dramaId && s.dramaId === series.dramaId));
  if (known) return known.number;
  const number = all.reduce((max, s) => Math.max(max, s.number), 0) + 1;
  all.push({ number, title: series.title, url: series.url, dramaId: series.dramaId, addedAt: now.toISOString() });
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.writeFileSync(registryFile(clipsDir), JSON.stringify(all, null, 2));
  return number;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderSeriesPage(series: SeriesEntry[]): string {
  const items = [...series]
    .sort((a, b) => b.number - a.number)
    .map(
      (s) =>
        `<li><a href="${escapeHtml(s.url)}" rel="nofollow noopener"><span class="n">n° ${s.number}</span>` +
        `<span class="t">${escapeHtml(s.title)}</span><span class="go">Regarder la suite ›</span></a></li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drama Express : la suite des séries</title>
<style>
:root{--bg:#0f0a0a;--card:#1c1414;--text:#f5f0eb;--muted:#b9aaa0;--accent:#e0b44c;--red:#c81e2b}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
h1{margin:0 0 4px;font-size:1.7rem;color:var(--accent)}p{margin:0 0 20px;color:var(--muted)}
ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
a{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;align-items:center;padding:14px 16px;border-radius:14px;
background:var(--card);color:var(--text);text-decoration:none;border:1px solid #3a2626}
a:active,a:hover{border-color:var(--accent)}
.n{grid-row:span 2;font-weight:800;font-size:1.1rem;color:var(--bg);background:var(--accent);border-radius:10px;padding:8px 10px}
.t{font-weight:600}.go{color:var(--red);font-size:.9rem;font-weight:700}
footer{margin-top:28px;font-size:.8rem;color:var(--muted)}
</style></head><body><main>
<h1>Drama Express</h1>
<p>Retrouvez le numéro de la série indiqué dans la vidéo et regardez la suite.</p>
<ul>
${items || "<li><p>Les premières séries arrivent bientôt.</p></li>"}
</ul>
<footer>Liens partenaires : Drama Express peut toucher une commission quand vous regardez une série.</footer>
</main></body></html>
`;
}

/** CLI: node dist/video/series.js <clipsDir> <outFile> */
const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, ".js").endsWith(path.join("video", "series.js"));
if (isMain) {
  const [clipsDir, outFile] = process.argv.slice(2);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, renderSeriesPage(loadSeries(clipsDir)));
}
