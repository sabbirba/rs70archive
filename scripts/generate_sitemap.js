#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const BASE_DIR = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(BASE_DIR, "sitemap.json");
const BASE_URL =
  process.env.JSDELIVR_BASE || "https://cdn.jsdelivr.net/gh/sabbirba/rs70archive@main/";
const SITEMAP_ROOT = process.env.SITEMAP_ROOT
  ? path.resolve(BASE_DIR, process.env.SITEMAP_ROOT)
  : BASE_DIR;
const SITEMAP_PREFIX = process.env.SITEMAP_PREFIX || "";
const ONLY_WEBP = process.env.ONLY_WEBP === "1";
const ROOT_IMAGE_EXTENSIONS = new Set([
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

function isHidden(name) {
  return name.startsWith(".");
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function buildEntries(baseDir, prefix) {
  const entries = [];
  let totalBytes = 0;
  let folderCount = 0;
  let fileCount = 0;

  const stack = [baseDir];

  while (stack.length) {
    const current = stack.pop();
    const relRootRaw = path.relative(baseDir, current);
    const relRoot = relRootRaw === "" ? "" : toPosix(relRootRaw);
    const prefixedRoot = relRoot ? `${prefix}${relRoot}` : prefix;

    if (relRoot && relRoot !== ".") {
      entries.push({
        type: "folder",
        path: prefixedRoot,
      });
      folderCount += 1;
    }

    const items = fs.readdirSync(current, { withFileTypes: true });

    for (const item of items) {
      if (isHidden(item.name)) {
        continue;
      }
      if (item.name === "node_modules") {
        continue;
      }
      const absPath = path.join(current, item.name);
      if (item.isDirectory()) {
        stack.push(absPath);
      } else if (item.isFile()) {
        const relPath = relRoot ? `${relRoot}/${item.name}` : item.name;
        const prefixedPath = `${prefix}${relPath}`;
        const ext = path.extname(item.name).replace(/^\./, "");
        if (!relRoot && ROOT_IMAGE_EXTENSIONS.has(ext.toLowerCase())) {
          continue;
        }
        if (ONLY_WEBP && ext.toLowerCase() !== "webp") {
          continue;
        }
        const stats = fs.statSync(absPath);
        totalBytes += stats.size;
        fileCount += 1;
        entries.push({
          type: "file",
          path: prefixedPath,
          bytes: stats.size,
          ext,
          cdn_path: encodeURI(prefixedPath),
        });
      }
    }
  }

  entries.sort((a, b) => {
    if (a.type === b.type) {
      return a.path.localeCompare(b.path);
    }
    return a.type.localeCompare(b.type);
  });

  return {
    entries,
    stats: {
      folders: folderCount,
      files: fileCount,
      total_bytes: totalBytes,
    },
  };
}

function main() {
  const normalizedPrefix = SITEMAP_PREFIX
    ? SITEMAP_PREFIX.replace(/\/?$/, "/")
    : "";
  const { entries, stats } = buildEntries(SITEMAP_ROOT, normalizedPrefix);
  const payload = {
    developer: "Sabbir Bin Abbas",
    devemail: "mail@sabbirba.com",
    devfb: "https://www.facebook.com/Sabbirba10",
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    stats,
    entries,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

main();
