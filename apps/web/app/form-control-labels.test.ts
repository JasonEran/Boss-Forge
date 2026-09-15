import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const controls = new Set([
  'input',
  'select',
  'textarea',
  'Input',
  'NativeSelect',
  'SelectTrigger',
  'Textarea',
  'Checkbox',
  'Switch',
]);

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function tagName(node: ts.JsxTagNameExpression): string {
  return node.getText();
}

function attribute(node: ts.JsxAttributes, name: string): ts.JsxAttribute | undefined {
  return node.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function stringAttribute(node: ts.JsxAttributes, name: string): string | null {
  const value = attribute(node, name)?.initializer;
  return value && ts.isStringLiteral(value) ? value.text : null;
}

function hasLabelAncestor(node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (
      ts.isJsxElement(current) &&
      ['label', 'Field'].includes(tagName(current.openingElement.tagName))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

describe('web form control labels', () => {
  it('gives every form control an associated label or accessible name', () => {
    const failures: string[] = [];
    let checkedControls = 0;

    for (const file of tsxFiles(join(process.cwd(), 'apps/web/app'))) {
      const source = readFileSync(file, 'utf8');
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const labelledIds = new Set<string>();

      function collectLabels(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) && tagName(node.tagName) === 'label') {
          const htmlFor = stringAttribute(node.attributes, 'htmlFor');
          if (htmlFor) labelledIds.add(htmlFor);
        }
        ts.forEachChild(node, collectLabels);
      }
      collectLabels(tree);

      function check(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const name = tagName(node.tagName);
          if (controls.has(name)) {
            checkedControls += 1;
            const attrs = node.attributes;
            const labelled =
              hasLabelAncestor(node) ||
              Boolean(attribute(attrs, 'aria-label')) ||
              Boolean(attribute(attrs, 'aria-labelledby')) ||
              Boolean(stringAttribute(attrs, 'id') && labelledIds.has(stringAttribute(attrs, 'id')!));
            if (!labelled) {
              const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              failures.push(`${file}:${line}: ${node.getText().slice(0, 120)}`);
            }
          }
        }
        ts.forEachChild(node, check);
      }
      check(tree);
    }

    expect(checkedControls).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
