import { describe, expect, it } from 'vitest';

import {
  configContainsSemantic,
  serializeTree,
  treeContainsSemantic,
  type TreeNode,
} from './rule-tree-model';

const semanticTree: TreeNode = {
  id: 'root',
  kind: 'group',
  operator: 'AND',
  children: [
    {
      id: 'cross-border',
      kind: 'leaf',
      leafType: 'semantic',
      value: '跨境电商',
      aliases: '海外电商，出海电商',
      label: '具备跨境电商经历',
      factType: 'industry',
      minimumConfidence: '0.8',
    },
  ],
};

describe('rule tree smart recognition', () => {
  it('serializes the HR-entered common expressions into the semantic rule', () => {
    expect(serializeTree(semanticTree)).toEqual({
      operator: 'AND',
      children: [
        {
          type: 'semantic',
          criterionId: 'semantic.cross-border',
          label: '具备跨境电商经历',
          executionMode: 'normalized_entity',
          factType: 'industry',
          expectedValues: ['跨境电商'],
          aliases: { 跨境电商: ['海外电商', '出海电商'] },
          valueMode: 'any',
          minimumConfidence: 0.8,
          unknownPolicy: 'manual_review',
        },
      ],
    });
  });

  it('detects smart recognition in editable and persisted trees', () => {
    const serialized = serializeTree(semanticTree);
    expect(treeContainsSemantic(semanticTree)).toBe(true);
    expect(configContainsSemantic({ schemaVersion: '1.1', root: serialized })).toBe(true);
  });
});
