// Server HTTPS lokal yang berpura-pura menjadi seller.shopee.co.id untuk uji
// end-to-end ekstensi (content script hanya ter-inject pada host asli).
// Jalankan: node tools/fixture/server.mjs
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = join(HERE, ".cert");
const KEY = join(CERT_DIR, "key.pem");
const CRT = join(CERT_DIR, "cert.pem");
const PORT = Number(process.env.PORT || 8443);

/** openssl sering tidak ada di PATH proses Node di Windows walau ada di Git bash. */
function opensslPath() {
  const candidates = [
    process.env.OPENSSL_BIN,
    "openssl",
    "C:/Program Files/Git/usr/bin/openssl.exe",
    "C:/Program Files/OpenSSL-Win64/bin/openssl.exe",
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* coba kandidat berikutnya */
    }
  }
  throw new Error("openssl tidak ditemukan; set OPENSSL_BIN=<path>");
}

if (!existsSync(KEY) || !existsSync(CRT)) {
  mkdirSync(CERT_DIR, { recursive: true });
  // Config file, bukan -subj/-addext: openssl.exe bawaan Git adalah biner MSYS
  // yang mengubah "/CN=..." menjadi path Windows dan merusak subject.
  const conf = join(CERT_DIR, "req.conf");
  writeFileSync(
    conf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      "CN = seller.shopee.co.id",
      "[ext]",
      "subjectAltName = DNS:seller.shopee.co.id",
      "basicConstraints = CA:FALSE",
      "",
    ].join("\n"),
  );
  execFileSync(
    opensslPath(),
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", KEY, "-out", CRT, "-days", "3", "-config", conf],
    { stdio: "ignore" },
  );
  console.log("cert dibuat di", CERT_DIR);
}

let chat = 0;
let notif = 0;

const server = createServer({ key: readFileSync(KEY), cert: readFileSync(CRT) }, (req, res) => {
  const url = new URL(req.url, "https://seller.shopee.co.id");
  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/webchat/unread") {
    if (url.searchParams.has("bump")) chat++;
    return json({ error: 0, data: { conversation: { unread_count: chat } } });
  }
  if (url.pathname === "/api/notification/unread_count") {
    if (url.searchParams.has("bump")) notif++;
    return json({ error: 0, data: { notification_unread_count: notif, banner_count: 0 } });
  }
  if (url.pathname === "/api/reset") {
    chat = 0;
    notif = 0;
    return json({ ok: true });
  }
  if (url.pathname === "/api/state") return json({ chat, notif });

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(join(HERE, "index.html")));
});

server.listen(PORT, "127.0.0.1", () => console.log(`fixture ready on https://127.0.0.1:${PORT}`));
