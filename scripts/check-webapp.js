const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const matches = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].filter(m => m[1].trim());
if (!matches.length) throw new Error("Web App inline JavaScript topilmadi.");
for (let i = 0; i < matches.length; i++) {
  const file = path.join(os.tmpdir(), "slayd-web-check-" + process.pid + "-" + i + ".js");
  fs.writeFileSync(file, matches[i][1]);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  fs.rmSync(file, { force: true });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}
console.log("Web App JavaScript syntax OK");
