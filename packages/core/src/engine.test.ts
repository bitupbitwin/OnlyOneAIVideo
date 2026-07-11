import assert from "node:assert/strict";
import test from "node:test";
import { compactLongMaterial } from "./engine.js";

test("短素材保持原样", () => {
  assert.equal(compactLongMaterial("  完整短素材  ", 100), "完整短素材");
});

test("长素材不超过预算，并保留开头、中部和结尾", () => {
  const source = `BEGIN-${"A".repeat(5000)}-MIDDLE-${"B".repeat(5000)}-END`;
  const result = compactLongMaterial(source, 1000);
  assert.ok(result.length <= 1000, `${result.length} > 1000`);
  assert.match(result, /^BEGIN-/);
  assert.match(result, /MIDDLE/);
  assert.match(result, /-END$/);
  assert.match(result, /数据库中仍完整保留/);
});
