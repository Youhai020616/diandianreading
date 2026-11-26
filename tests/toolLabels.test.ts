import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatToolLabel, TOOL_LABEL_MAP } from "../src/components/askPanel/askPanelShared";

const pluginsDir = path.resolve(__dirname, "..", "plugins");

function pluginToolNames(): string[] {
  const names = new Set<string>();
  for (const plugin of fs.readdirSync(pluginsDir)) {
    const entry = path.join(pluginsDir, plugin, "index.mjs");
    if (!fs.existsSync(entry)) continue;
    for (const match of fs.readFileSync(entry, "utf8").matchAll(/defineTool\(\{\s*name:\s*"([a-z_]+)"/g)) names.add(match[1]!);
  }
  return [...names];
}

describe("tool labels in the ask panel", () => {
  it("names every tool 点点读书's plugins register", () => {
    const tools = pluginToolNames();
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.filter((name) => !(name in TOOL_LABEL_MAP))).toEqual([]);
  });

  it("lists no tool that no plugin registers any more", () => {
    const pluginTools = new Set(pluginToolNames());
    const harness = ["web_fetch", "web_search", "read", "read_image", "grep", "glob", "present", "todo_write", "ask_user_question",
      "subagent", "subagent_fork", "send_message", "wait_agent", "list_agents", "create_goal", "get_goal", "update_goal",
      "schedule_create", "schedule_edit", "schedule_list", "schedule_view", "job_list", "job_output", "job_kill"];
    expect(Object.keys(TOOL_LABEL_MAP).filter((name) => !pluginTools.has(name) && !harness.includes(name))).toEqual([]);
  });

  it("falls back to a readable name for anything else", () => {
    expect(formatToolLabel("library_get_highlights")).toBe("读取书籍划线");
    expect(formatToolLabel("some_new_tool")).toBe("some new tool");
  });
});
