import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(process.cwd());

test("history controls use centered outline SVG arrows without font glyphs", async () => {
  const html = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const styles = await fs.readFile(path.join(root, "web", "styles.css"), "utf8");
  for (const [id, label, title, glyph] of [
    ["undo-button", "撤销", "撤销（⌘/Ctrl+Z）", "↶"],
    ["redo-button", "重做", "重做（⌘/Ctrl+Shift+Z）", "↷"]
  ]) {
    const button = html.match(new RegExp(`<button id="${id}"[\\s\\S]*?</button>`))?.[0] ?? "";
    assert.match(button, new RegExp(`aria-label="${label}"`));
    assert.match(button, new RegExp(`title="${title.replace(/[()⌘+]/g, "\\$&")}"`));
    assert.doesNotMatch(button, new RegExp(glyph));
    assert.match(button, /<svg class="history-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">/);
    assert.equal((button.match(/<path\b/g) ?? []).length, 2);
  }
  assert.match(styles, /\.history-icon\s*\{[^}]*width:\s*18px[^}]*height:\s*18px[^}]*stroke-width:\s*1\.65[^}]*stroke-linecap:\s*round[^}]*stroke-linejoin:\s*round/);
});
