import { describe, expect, it } from "vitest";
import { RuleConfigValidationError, parseRuleConfig } from "./rule-config.js";

function semanticLeaf() {
  return {
    type: "semantic",
    criterionId: "semantic.skill.java",
    label: "具备 Java 后端能力",
    executionMode: "normalized_entity",
    factType: "skill",
    expectedValues: ["Java"],
    aliases: { Java: ["J2EE", "Java 后端"] },
    valueMode: "any",
    minimumConfidence: 0.8,
    unknownPolicy: "manual_review"
  };
}

describe("semantic rule config", () => {
  it("accepts strict schema 1.1 semantic rules", () => {
    const parsed = parseRuleConfig({
      schemaVersion: "1.1",
      root: { operator: "AND", children: [semanticLeaf()] }
    });
    expect(parsed).toMatchObject({ schemaVersion: "1.1" });
  });

  it("rejects semantic leaves in schema 1.0", () => {
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: { operator: "AND", children: [semanticLeaf()] }
      })
    ).toThrow(/requires config\.schemaVersion 1\.1/u);
  });

  it("rejects aliases without matching canonical values", () => {
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.1",
        root: {
          operator: "AND",
          children: [{ ...semanticLeaf(), aliases: { Python: ["Py"] } }]
        }
      })
    ).toThrow(RuleConfigValidationError);
  });

  it("rejects duplicate semantic criterion identifiers", () => {
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.1",
        root: { operator: "AND", children: [semanticLeaf(), semanticLeaf()] }
      })
    ).toThrow(/duplicates/u);
  });
});
