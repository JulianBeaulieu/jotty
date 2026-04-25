const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const standaloneDir = path.join(rootDir, ".next", "standalone");

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 1. Copy custom server.js (overwrites Next.js generated one)
fs.copyFileSync(
  path.join(rootDir, "server.js"),
  path.join(standaloneDir, "server.js")
);

// 2. Copy collab CJS server modules (required by server.js at runtime)
const collabSrc = path.join(rootDir, "app", "_server", "collab");
const collabDest = path.join(standaloneDir, "app", "_server", "collab");
if (fs.existsSync(collabSrc)) {
  copyDirSync(collabSrc, collabDest);
}

// 3. Copy any node_modules packages missing from the standalone trace.
//    Next.js only traces packages imported by its own pages/actions; our
//    CJS collab modules and the custom server.js need their deps too.
const srcModules = path.join(rootDir, "node_modules");
const destModules = path.join(standaloneDir, "node_modules");

let copied = 0;
for (const entry of fs.readdirSync(srcModules, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith("@")) {
    // Scoped packages: iterate children
    const scopeSrc = path.join(srcModules, entry.name);
    const scopeDest = path.join(destModules, entry.name);
    for (const scoped of fs.readdirSync(scopeSrc, { withFileTypes: true })) {
      if (!scoped.isDirectory()) continue;
      const s = path.join(scopeSrc, scoped.name);
      const d = path.join(scopeDest, scoped.name);
      if (!fs.existsSync(d)) {
        copyDirSync(s, d);
        copied++;
      }
    }
  } else {
    const s = path.join(srcModules, entry.name);
    const d = path.join(destModules, entry.name);
    if (!fs.existsSync(d)) {
      copyDirSync(s, d);
      copied++;
    }
  }
}

console.log(
  `Postbuild: server.js + collab modules copied; ${copied} node_modules packages back-filled into standalone`
);
