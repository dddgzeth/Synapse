/**
 * Manually trigger L2 (scene extraction) + L3 (persona generation)
 * on all existing L1 memories. Used to verify the pipeline end-to-end
 * without waiting for the next chat-driven L1 trigger.
 */
import { queryAllL1 } from "../lib/memory/store";
import { runL2L3Pipeline } from "../lib/memory/l2-l3-pipeline";
import path from "node:path";
import fs from "node:fs";

async function main() {
  const all = queryAllL1(200);
  console.log(`[trigger] Found ${all.length} L1 records, sending all to L2/L3 pipeline...`);
  if (all.length === 0) {
    console.log("[trigger] No memories to process — exiting");
    return;
  }
  await runL2L3Pipeline({
    newMemories: all.map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt })),
  });

  // Inspect results
  const dataDir = process.env.TDAI_DATA_DIR ?? path.join(process.cwd(), "data");
  const blocksDir = path.join(dataDir, "scene_blocks");
  const personaPath = path.join(dataDir, "persona.md");

  console.log("\n=== Result ===");
  if (fs.existsSync(blocksDir)) {
    const files = fs.readdirSync(blocksDir).filter((f) => f.endsWith(".md"));
    console.log(`scene_blocks: ${files.length} file(s)`);
    for (const f of files) {
      const content = fs.readFileSync(path.join(blocksDir, f), "utf-8");
      console.log(`  - ${f} (${content.length} chars)`);
    }
  } else {
    console.log("scene_blocks: (dir not created)");
  }
  if (fs.existsSync(personaPath)) {
    const content = fs.readFileSync(personaPath, "utf-8");
    console.log(`persona.md: ${content.length} chars`);
  } else {
    console.log("persona.md: (not generated)");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
