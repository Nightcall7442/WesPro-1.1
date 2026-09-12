// Сборка WesPro.exe — программы клуба одним файлом, без установки Node.
//
//   npm run build:exe   →   dist/WesPro.exe (+ dist/start-wespro.bat)
//
// Как устроено: esbuild склеивает src/ и зависимости в один CommonJS-файл,
// страницы интерфейса (public/) зашиваются внутрь как ресурсы, а Node
// (Single Executable Application) вклеивает всё это в копию своего же
// node.exe. При запуске exe распаковывает public/ рядом с собой (см.
// src/config.js) и работает как обычный «один клуб»: база billiards.db
// в той же папке, копии в backups/, журнал ошибок в logs/.
//
// Запускать на Windows тем же Node, что пойдёт в exe (нужен Node 22+).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

if (process.platform !== "win32") {
  console.error("WesPro.exe собирается на Windows: exe — копия node.exe этой же машины.");
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. Один файл кода. import.meta.url в CommonJS нет — подставляем
//    __filename, а версию зашиваем константой: package.json рядом с exe
//    не лежит.
const bundle = path.join(DIST, "wespro.cjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src", "server.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: bundle,
  logLevel: "warning",
  define: {
    "import.meta.url": "__wespro_meta_url",
    __WESPRO_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: 'const __wespro_meta_url = require("node:url").pathToFileURL(__filename).href;',
  },
});

// 2. Страницы интерфейса — ресурсами внутрь exe, плюс список, по которому
//    их распаковать (у SEA нет «перечислить ресурсы»).
const publicDir = path.join(ROOT, "public");
const assets = {};
const manifest = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      const rel = path.relative(publicDir, full).split(path.sep).join("/");
      manifest.push(rel);
      assets[`public/${rel}`] = full;
    }
  }
};
walk(publicDir);
const manifestFile = path.join(DIST, "public-manifest.json");
fs.writeFileSync(manifestFile, JSON.stringify(manifest));
assets["public-manifest.json"] = manifestFile;

const seaConfig = path.join(DIST, "sea-config.json");
const blob = path.join(DIST, "sea-prep.blob");
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, assets }, null, 2)
);

// 3. Блоб и вклейка в копию node.exe.
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
const exe = path.join(DIST, "WesPro.exe");
fs.copyFileSync(process.execPath, exe);
execFileSync(
  process.execPath,
  [
    path.join(ROOT, "node_modules", "postject", "dist", "cli.js"),
    exe,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit" }
);

// 4. Окно сервера с перезапуском по кнопке «Перезапустить программу»
//    (код выхода 7) — как run-server.bat, только для exe.
fs.writeFileSync(
  path.join(DIST, "start-wespro.bat"),
  [
    "@echo off",
    "cd /d \"%~dp0\"",
    "title WesPro",
    ":loop",
    "WesPro.exe",
    "if \"%errorlevel%\"==\"7\" goto loop",
    "echo.",
    "echo WesPro ostanovlen. Mozhno zakryt okno.",
    "pause",
    "",
  ].join("\r\n")
);

for (const leftover of [bundle, blob, seaConfig, manifestFile]) fs.rmSync(leftover, { force: true });
const size = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`Готово: ${exe} (${size} МБ), версия ${pkg.version}. Рядом — start-wespro.bat.`);
