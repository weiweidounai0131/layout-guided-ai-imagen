import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(process.cwd());

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("public workflow Skill is sketch-ai-imagen without a duplicate legacy directory", async () => {
  const publicSkillPath = path.join(root, "skills", "sketch-ai-imagen", "SKILL.md");
  const legacySkillPath = path.join(root, "skills", "layout-guided-ai-imagen-workflow", "SKILL.md");
  const skill = await fs.readFile(publicSkillPath, "utf8");
  const plugin = JSON.parse(await fs.readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));

  assert.equal(await exists(publicSkillPath), true);
  assert.equal(await exists(legacySkillPath), false);
  assert.match(skill, /^---\nname: sketch-ai-imagen\n/m);
  assert.match(skill, /@sketch-ai-imagen/);
  assert.doesNotMatch(skill, /^name: layout-guided-ai-imagen-workflow$/m);
  assert.equal(plugin.name, "layout-guided-ai-imagen");
  assert.equal(plugin.version, "0.2.11");
  assert.match(plugin.interface.defaultPrompt.join("\n"), /@sketch-ai-imagen/);
});
