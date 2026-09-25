import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hypaExtension from "../extensions/index.js";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-hypa-bash-rewrite-"));

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function fakePi() {
  const events = new Map<string, unknown[]>();
  const tools: string[] = [];
  const pi = {
    on(event: string, handler: unknown) {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    registerTool(definition: { name: string }) {
      tools.push(definition.name);
    },
    registerCommand() {},
  };
  return { pi, events, tools };
}

function configFile(value: unknown): string {
  const file = join(tempRoot, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

/** 工厂直接读 process.env，因此按用例注入环境，结束后恢复。 */
function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const keys = ["HYPA_PI_CONFIG", "HYPA_PI_BASH_REWRITE", "HYPA_PI_MODE"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// SAFETY: fakePi 只实现工厂加载期触碰的表面（on/registerTool/registerCommand），
// 运行时断言的是 handler 注册结果，不需要 ExtensionAPI 的其余成员。
function load(env: Record<string, string | undefined>) {
  const { pi, events, tools } = fakePi();
  withEnv(env, () => hypaExtension(pi as unknown as ExtensionAPI));
  return { events, tools };
}

test("bash rewriting is on by default and registers the tool_call hook", () => {
  // 显式给一个空配置文件：默认值断言不能被机器的 ~/.hypa-pi/config.json 影响
  const { events, tools } = load({ HYPA_PI_CONFIG: configFile({}) });
  assert.equal(events.get("tool_call")?.length, 1);
  assert.ok(tools.includes("hypa_read"), "hypa_* tools must still be registered");
});

test("bashRewrite=false registers no tool_call hook but keeps hypa_* tools", () => {
  const { events, tools } = load({ HYPA_PI_CONFIG: configFile({ bashRewrite: false }) });
  assert.equal(events.has("tool_call"), false, "bash must stay unwrapped when rewriting is off");
  assert.deepEqual(tools, ["hypa_shell", "hypa_read", "hypa_grep", "hypa_find", "hypa_ls"]);
  assert.equal(events.get("before_agent_start")?.length ?? 0, 0, "additive mode must not touch active tools");
});

test("HYPA_PI_BASH_REWRITE=off overrides an enabled config file", () => {
  const { events } = load({
    HYPA_PI_CONFIG: configFile({ bashRewrite: true }),
    HYPA_PI_BASH_REWRITE: "off",
  });
  assert.equal(events.has("tool_call"), false);
});

test("bash rewriting can be re-enabled from the config file", () => {
  const { events } = load({ HYPA_PI_CONFIG: configFile({ bashRewrite: true }) });
  assert.equal(events.get("tool_call")?.length, 1);
});
