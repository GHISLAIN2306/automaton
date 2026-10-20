#!/usr/bin/env node
/**
 * Video CLI
 *
 *   node dist/video/cli.js make <script.json>       render a video into the review queue
 *   node dist/video/cli.js list                     show the queue
 *   node dist/video/cli.js approve <id> [note]      mark a video approved (human only)
 *   node dist/video/cli.js reject <id> [note]       mark a video rejected (human only)
 *
 * Nothing here publishes: approved videos stay on disk until a publishing
 * step exists and its owner has agreed to it.
 */

import fs from "fs";
import path from "path";
import { createVideo, formatVideoList, getVideosDir, listVideos, setVideoStatus } from "./review.js";

async function main(argv: string[]): Promise<number> {
  const [command, arg, ...rest] = argv;
  switch (command) {
    case "make": {
      if (!arg) throw new Error("Usage: make <script.json>");
      const script = JSON.parse(fs.readFileSync(arg, "utf-8"));
      const manifest = await createVideo(script);
      console.log(`Rendered ${manifest.id}: ${manifest.durationSec}s, cost $${(manifest.costCents / 100).toFixed(2)}`);
      for (const c of manifest.checks) console.log(`  ${c.passed ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
      console.log(`  file: ${path.join(getVideosDir(), manifest.id, "video.mp4")}`);
      return 0;
    }
    case "list":
      console.log(formatVideoList(listVideos()));
      return 0;
    case "approve":
    case "reject": {
      if (!arg) throw new Error(`Usage: ${command} <id> [note]`);
      const manifest = setVideoStatus(arg, command === "approve" ? "approved" : "rejected", rest.join(" ") || undefined);
      console.log(`${manifest.id} is now ${manifest.status}`);
      return 0;
    }
    default:
      console.log("Usage: cli.js make <script.json> | list | approve <id> [note] | reject <id> [note]");
      return command ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
