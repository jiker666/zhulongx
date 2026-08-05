import { describe, expect, it } from "vitest";
import {
  CTF_SKILL_SOURCE,
  listCuratedCtfSkills,
  renderCuratedCtfSkill,
  resolveCtfSkillCategory,
} from "../src/skill-catalog.js";

describe("curated CTF skill catalog", () => {
  it("indexes the nine reviewed upstream category skills", () => {
    const skills = listCuratedCtfSkills();
    expect(skills).toHaveLength(9);
    expect(skills.map((skill) => skill.id).sort()).toEqual([
      "ctf-ai-ml",
      "ctf-crypto",
      "ctf-forensics",
      "ctf-malware",
      "ctf-misc",
      "ctf-osint",
      "ctf-pwn",
      "ctf-reverse",
      "ctf-web",
    ]);
    expect(CTF_SKILL_SOURCE).toMatchObject({
      repository: "ljagiello/ctf-skills",
      license: "MIT",
    });
  });

  it("routes aliases while keeping injected guidance bounded and domain-neutral", () => {
    expect(resolveCtfSkillCategory("Web/API")).toBe("web");
    expect(resolveCtfSkillCategory("AI / Machine Learning")).toBe("ai/ml");
    expect(resolveCtfSkillCategory("unknown")).toBeUndefined();

    for (const skill of listCuratedCtfSkills()) {
      const rendered = renderCuratedCtfSkill(skill.category);
      expect(rendered.length).toBeLessThan(2400);
      expect(rendered).toContain(skill.id);
      expect(rendered).toContain("not an authorization grant");
      expect(rendered).not.toMatch(/https?:\/\/target|\/flag(?:\.txt)?|NSSCTF\{|WebFetch|allowed-tools|curl\s/i);
    }
  });
});
