"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const output = path.join(root, "public");
const publicFiles = [
  "index.html",
  "script.js",
  "style.css",
  "payments.html",
  "payments.js",
  "payments.css",
  "payment-result.html",
  "payment-result.js"
];

fs.mkdirSync(output, { recursive: true });
for (const file of publicFiles) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
fs.cpSync(path.join(root, "assets"), path.join(output, "assets"), { recursive: true });

console.log(`Built ${publicFiles.length} website files and assets into ${path.relative(root, output)}.`);
