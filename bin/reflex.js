#!/usr/bin/env node
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  process.stderr.write(`reflex needs Node.js 20 or newer (this is ${process.version})\n`);
  process.exit(1);
}
const { run } = await import("../dist/cli.js");
run();
