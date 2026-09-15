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

describe("HR profile rule config", () => {
  it("accepts age, graduation year, graduate status, gender, and CET6-or-TEM8 rules", () => {
    const parsed = parseRuleConfig({
      schemaVersion: "1.0",
      root: {
        operator: "AND",
        children: [
          {
            type: "english_credential",
            accepted: ["cet6", "tem8"],
            mode: "any",
            minimumConfidence: 0.86,
            unknownPolicy: "manual_review"
          },
          { type: "range", field: "age", minimum: 22, maximum: 35, unknownPolicy: "manual_review" },
          { type: "range", field: "graduationYear", maximum: 2026, unknownPolicy: "manual_review" },
          {
            type: "graduate_status",
            values: ["current_or_upcoming_graduate"],
            mode: "any",
            unknownPolicy: "manual_review"
          },
          {
            type: "enum",
            field: "gender",
            values: ["女"],
            mode: "any",
            match: "exact",
            unknownPolicy: "manual_review"
          }
        ]
      }
    });
    expect(parsed).toMatchObject({
      root: {
        children: [
          { type: "english_credential", accepted: ["cet6", "tem8"], mode: "any" },
          { type: "range", field: "age", minimum: 22, maximum: 35 },
          { type: "range", field: "graduationYear", maximum: 2026 },
          {
            type: "graduate_status",
            values: ["current_or_upcoming_graduate"],
            mode: "any"
          },
          { type: "enum", field: "gender", values: ["女"] }
        ]
      }
    });
  });

  it("rejects unknown or logically impossible graduate-status settings", () => {
    for (const node of [
      {
        type: "graduate_status",
        values: ["intern"],
        mode: "any",
        unknownPolicy: "manual_review"
      },
      {
        type: "graduate_status",
        values: ["current_or_upcoming_graduate", "experienced"],
        mode: "all",
        unknownPolicy: "manual_review"
      }
    ]) {
      expect(() =>
        parseRuleConfig({
          schemaVersion: "1.0",
          root: { operator: "AND", children: [node] }
        })
      ).toThrow(RuleConfigValidationError);
    }
  });

  it("rejects unsupported credentials and unrealistic profile boundaries", () => {
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: {
          operator: "AND",
          children: [
            {
              type: "english_credential",
              accepted: ["cet4"],
              mode: "any",
              minimumConfidence: 0.8,
              unknownPolicy: "manual_review"
            }
          ]
        }
      })
    ).toThrow(/tem8 and cet6/u);
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: {
          operator: "AND",
          children: [
            { type: "range", field: "age", minimum: 8, unknownPolicy: "manual_review" }
          ]
        }
      })
    ).toThrow(/between 16 and 100/u);
  });
});
