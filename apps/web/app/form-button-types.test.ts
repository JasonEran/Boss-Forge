import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("web form buttons", () => {
  it("declares an explicit type for every Button inside a form", () => {
    const failures: string[] = [];
    let checkedButtons = 0;

    for (const file of tsxFiles(join(process.cwd(), "apps/web/app"))) {
      const source = readFileSync(file, "utf8");
      for (const form of source.matchAll(/<form\b[\s\S]*?<\/form>/g)) {
        const formLine = source.slice(0, form.index).split("\n").length;
        for (const button of form[0].matchAll(/<Button\b[^>]*>/g)) {
          checkedButtons += 1;
          if (!/\btype\s*=/.test(button[0])) {
            failures.push(`${file}:${formLine}: ${button[0].replace(/\s+/g, " ")}`);
          }
        }
      }
    }

    expect(checkedButtons).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
