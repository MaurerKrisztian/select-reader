// Copies the window's HTML and CSS next to the compiled JavaScript in dist/renderer.
import fs from "node:fs";

for (const file of fs.readdirSync("src/renderer")) {
  if (file.endsWith(".html") || file.endsWith(".css")) {
    fs.copyFileSync(`src/renderer/${file}`, `dist/renderer/${file}`);
  }
}
