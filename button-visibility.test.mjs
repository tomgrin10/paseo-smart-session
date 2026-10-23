import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function fixture() {
  let listener;
  const source = ts.transpileModule(readFileSync(new URL("./client/button-visibility.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(() => ({ subscribeDisplay(fn) { listener = fn; return () => { listener = undefined; }; } }), module, module.exports);
  const active = new Map();
  const registered = [];
  const register = input => {
    assert.ok(!active.has(input.id), "a contribution must never be registered twice");
    const state = { ...input.button }; registered.push(state); active.set(input.id, state);
    return { update(patch) { Object.assign(state, patch); }, remove() { active.delete(input.id); } };
  };
  const adapted = module.exports.withButtonVisibility({ addHeaderButton: register, addComposerPill: register });
  return { ...adapted, active, registered, save(values) { listener?.({ enable_header_button: true, enable_composer_button: true, ...values }); } };
}

test("hidden buttons preserve current descriptors, cover newly discovered workspaces, and return once", () => {
  const f = fixture();
  const contribution = { id: "first", workspaceId: "workspace", button: { title: "Open", label: "Original", icon: "Settings", behavior: { kind: "action", onPress() {} } } };
  const method = "composer" === "header" ? "addHeaderButton" : "addComposerPill";
  const flag = `enable_${"composer"}_button`;
  const first = f.client[method](contribution);
  f.save({ [flag]: false });
  assert.equal(f.active.size, 0);
  first.update({ label: "Current" });
  const second = f.client[method]({ ...contribution, id: "second" });
  assert.equal(f.active.size, 0, "new workspaces respect the saved hidden choice");
  second.remove();
  f.save({ [flag]: true });
  f.save({ [flag]: true });
  assert.equal(f.active.size, 1);
  assert.equal(f.active.get("first").label, "Current");
  f.dispose();
  assert.equal(f.active.size, 0);
  f.save({ [flag]: true });
  assert.equal(f.active.size, 0, "late preference changes cannot resurrect disposed buttons");
});
