#!/usr/bin/env node
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const sharp = require("sharp");

const BASE_DIR = path.resolve(__dirname, "..");
const SRC_DIR = process.env.SOURCE_DIR
  ? path.resolve(BASE_DIR, process.env.SOURCE_DIR)
  : BASE_DIR;
const OUT_DIR = process.env.OUTPUT_DIR
  ? path.resolve(BASE_DIR, process.env.OUTPUT_DIR)
  : SRC_DIR;
const TARGET_KB = 100;
const MAX_QUALITY = Number.parseInt(process.env.WEBP_MAX_QUALITY || "95", 10);
const MIN_QUALITY = Number.parseInt(process.env.WEBP_MIN_QUALITY || "50", 10);
const CONCURRENCY = Number.parseInt(process.env.WEBP_CONCURRENCY || "10", 10);
const PROCESS_CR2 = process.env.WEBP_PROCESS_CR2 === "1";
const FORCE = process.argv.includes("--force") || process.env.WEBP_FORCE === "1";
const TARGET_BYTES = TARGET_KB * 1024;

const SUPPORTED_EXT = new Set([
  "jpg",
  "jpeg",
  "png",
  "tif",
  "tiff",
  "webp",
  "cr2",
]);

function isHidden(name) {
  return name.startsWith(".");
}

async function mapLimit(items, limit, iterator) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      results.push(await iterator(current, index, items.length));
    }
  }

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  return results;
}

async function walk(dir, outputDirName, files = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (isHidden(entry.name)) {
      continue;
    }
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === outputDirName) {
        continue;
      }
      await walk(path.join(dir, entry.name), outputDirName, files);
    } else if (entry.isFile()) {
      if (dir === SRC_DIR) {
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (SUPPORTED_EXT.has(ext)) {
        if (ext === "cr2" && !PROCESS_CR2) {
          continue;
        }
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

async function convertFile(inputPath, currentIndex, total) {
  const relPath = path.relative(SRC_DIR, inputPath);
  const outputRel = relPath.replace(/\.[^.]+$/, ".webp");
  const outputPath = path.join(OUT_DIR, outputRel);

  console.log(`[${currentIndex}/${total}] start: ${relPath}`);

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  if (!FORCE && fs.existsSync(outputPath)) {
    if (inputPath === outputPath) {
      const outStat = await fsp.stat(outputPath);
      if (outStat.size <= TARGET_BYTES) {
        return { status: "skipped", inputPath, outputPath };
      }
    } else {
      const inStat = await fsp.stat(inputPath);
      const outStat = await fsp.stat(outputPath);
      if (outStat.mtimeMs >= inStat.mtimeMs) {
        return { status: "skipped", inputPath, outputPath };
      }
    }
  }

  try {
    const meta = await sharp(inputPath).metadata();
    let width = meta.width || null;
    let height = meta.height || null;
    let lastBuffer = null;
    let success = false;

    for (let scale = 1; scale >= 0.4 && !success; scale -= 0.1) {
      let quality = MAX_QUALITY;
      const resizedWidth = width ? Math.max(1, Math.round(width * scale)) : null;
      const resizedHeight = height ? Math.max(1, Math.round(height * scale)) : null;

      while (quality >= MIN_QUALITY) {
        let pipeline = sharp(inputPath);
        if (resizedWidth && resizedHeight) {
          pipeline = pipeline.resize(resizedWidth, resizedHeight, {
            fit: "inside",
            withoutEnlargement: true,
          });
        }
        const buffer = await pipeline.webp({ quality }).toBuffer();
        lastBuffer = buffer;
        if (buffer.length <= TARGET_BYTES) {
          success = true;
          break;
        }
        quality -= 5;
      }
    }

    if (lastBuffer) {
      await fsp.writeFile(outputPath, lastBuffer);
      const status = success ? "converted" : "converted_over";
      console.log(`[${currentIndex}/${total}] ${status}: ${relPath}`);
      return { status, inputPath, outputPath };
    }
    return { status: "failed", inputPath, error: new Error("No output buffer") };
  } catch (error) {
    console.log(`[${currentIndex}/${total}] failed: ${relPath}`);
    return { status: "failed", inputPath, error };
  }
}

async function main() {
  const outputDirName = path.basename(OUT_DIR);
  const files = await walk(SRC_DIR, outputDirName);

  console.log(`Found ${files.length} files to process.`);
  const start = Date.now();
  let completed = 0;
  const interval = setInterval(() => {
    const seconds = Math.round((Date.now() - start) / 1000);
    process.stdout.write(
      `Progress: ${completed}/${files.length} files in ${seconds}s\r`
    );
  }, 1000);

  const results = await mapLimit(files, CONCURRENCY, async (file, currentIndex, total) => {
    const result = await convertFile(file, currentIndex, total);
    completed += 1;
    return result;
  });

  clearInterval(interval);
  process.stdout.write("\n");

  const summary = results.reduce(
    (acc, item) => {
      if (!acc[item.status]) {
        acc[item.status] = 0;
      }
      acc[item.status] += 1;
      return acc;
    },
    { converted: 0, converted_over: 0, skipped: 0, failed: 0 }
  );

  console.log(`Converted: ${summary.converted}`);
  console.log(`Converted over target: ${summary.converted_over}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Failed: ${summary.failed}`);
  const totalSeconds = Math.round((Date.now() - start) / 1000);
  console.log(`Total time: ${totalSeconds}s`);

  if (summary.failed > 0) {
    console.log("Some files failed. RAW formats like .CR2 may require extra codecs.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
