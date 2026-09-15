export type LeafType =
  | 'tem8'
  | 'education'
  | 'experience'
  | 'keyword'
  | 'boss_tags'
  | 'semantic';

export type TreeNode = {
  id: string;
  kind: 'group' | 'leaf';
  operator?: 'AND' | 'OR' | 'NOT';
  leafType?: LeafType;
  value?: string;
  aliases?: string;
  label?: string;
  factType?: string;
  minimumConfidence?: string;
  children?: TreeNode[];
};

const id = () => crypto.randomUUID();

export function newRuleLeaf(leafType: LeafType = 'keyword'): TreeNode {
  return {
    id: id(),
    kind: 'leaf',
    leafType,
    value: leafType === 'tem8' ? '0.8' : '',
    aliases: leafType === 'semantic' ? '' : undefined,
    label: leafType === 'semantic' ? '具备相关技能或经历' : undefined,
    factType: leafType === 'semantic' ? 'skill' : undefined,
    minimumConfidence: leafType === 'semantic' ? '0.8' : undefined,
  };
}

export const initialTree = (): TreeNode => ({
  id: id(),
  kind: 'group',
  operator: 'AND',
  children: [newRuleLeaf('tem8')],
});

function splitValues(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,，、\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function serializeTree(node: TreeNode): unknown {
  if (node.kind === 'group') {
    return {
      operator: node.operator,
      children: (node.children ?? []).map(serializeTree),
    };
  }
  if (node.leafType === 'tem8') {
    return {
      type: 'tem8',
      minimumConfidence: Number(node.value || 0.8),
      unknownPolicy: 'manual_review',
    };
  }
  if (node.leafType === 'education') {
    return {
      type: 'education_level',
      minimum: node.value || 'bachelor',
      unknownPolicy: 'manual_review',
    };
  }
  if (node.leafType === 'experience') {
    return {
      type: 'range',
      field: 'yearsOfExperience',
      minimum: Number(node.value || 0),
      unknownPolicy: 'manual_review',
    };
  }
  if (node.leafType === 'boss_tags') {
    return {
      type: 'enum',
      field: 'bossPlatformTags',
      values: splitValues(node.value),
      mode: 'any',
      match: 'contains',
      unknownPolicy: 'manual_review',
    };
  }
  if (node.leafType === 'semantic') {
    const canonical = node.value?.trim() ?? '';
    const aliases = splitValues(node.aliases);
    return {
      type: 'semantic',
      criterionId: `semantic.${node.id}`,
      label: node.label?.trim() || '智能识别条件',
      executionMode: 'normalized_entity',
      factType: node.factType || 'skill',
      expectedValues: canonical ? [canonical] : [],
      ...(canonical && aliases.length > 0
        ? { aliases: { [canonical]: aliases } }
        : {}),
      valueMode: 'any',
      minimumConfidence: Number(node.minimumConfidence || 0.8),
      unknownPolicy: 'manual_review',
    };
  }
  return {
    type: 'keyword',
    field: 'all',
    values: splitValues(node.value),
    mode: 'all',
    unknownPolicy: 'manual_review',
  };
}

export function treeContainsSemantic(node: TreeNode): boolean {
  if (node.kind === 'leaf') return node.leafType === 'semantic';
  return (node.children ?? []).some(treeContainsSemantic);
}

export function configContainsSemantic(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'semantic') return true;
  if (Array.isArray(record.children)) return record.children.some(configContainsSemantic);
  return configContainsSemantic(record.root);
}
