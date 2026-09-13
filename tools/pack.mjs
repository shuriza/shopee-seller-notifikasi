// Bundel ekstensi untuk unggah ke Chrome Web Store (tanpa tools/ & node_modules).
// Jalankan: node tools/pack.mjs  -> dist/shopee-seller-notifier-<versi>.zip
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const DIST = join(ROOT, "dist");
const OUT = join(DIST, `shopee-seller-notifier-${version}.zip`);

const INCLUDE = ["manifest.json", "assets", "src"];
for (const entry of INCLUDE) {
  if (!existsSync(join(ROOT, entry))) throw new Error(`hilang: ${entry}`);
}

mkdirSync(DIST, { recursive: true });
rmSync(OUT, { force: true });

// PowerShell Compress-Archive selalu ada di Windows; hindari dependensi zip CLI.
const list = INCLUDE.map((e) => `'${e}'`).join(",");
execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path ${list} -DestinationPath '${OUT}' -Force`],
  { cwd: ROOT, stdio: "inherit" },
);

console.log("paket dibuat:", OUT.replace(ROOT + "\\", ""));
