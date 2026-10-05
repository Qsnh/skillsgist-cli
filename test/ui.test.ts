import { describe, expect, it, vi } from "vitest";
import type { SkillEntry } from "../src/registry.js";

const multiselect = vi.hoisted(() => vi.fn());

vi.mock("@clack/prompts", () => ({ multiselect, isCancel: () => false }));

const { clackUi } = await import("../src/ui.js");

const KEY = "0123456789abcdef0123456789abcdef";

const skill = (description: string): SkillEntry => ({
  name: "demo-skill",
  description,
  url: "https://skills.example.com/d/demo-skill.zip",
  digest: `sha256:${"0".repeat(64)}`,
});

describe("clackUi", () => {
  it("masks a key in a skill's hint even where the hint is cut short", async () => {
    multiselect.mockResolvedValue(["demo-skill"]);
    await clackUi().selectSkills([skill(`${"x".repeat(20)} https://h.example/i/${KEY}/.well-known/agent-skills/demo-skill`)]);
    const hint: string = multiselect.mock.calls[0][0].options[0].hint;
    expect(hint).toContain("/i/0123…");
    expect(hint).not.toContain(KEY.slice(0, 5));
  });
});
