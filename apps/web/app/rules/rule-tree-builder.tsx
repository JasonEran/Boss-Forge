'use client';

import { Button } from '@/components/ui/button';
import { Field, inputClass } from '../workspace-ui';
import {
  newRuleLeaf,
  type LeafType,
  type TreeNode,
} from './rule-tree-model';

function update(
  root: TreeNode,
  target: string,
  transform: (node: TreeNode) => TreeNode,
): TreeNode {
  if (root.id === target) return transform(root);
  return root.kind === 'group'
    ? {
        ...root,
        children: (root.children ?? []).map((child) =>
          update(child, target, transform),
        ),
      }
    : root;
}

function remove(root: TreeNode, target: string): TreeNode {
  return root.kind === 'group'
    ? {
        ...root,
        children: (root.children ?? [])
          .filter((child) => child.id !== target)
          .map((child) => remove(child, target)),
      }
    : root;
}

function Node({
  node,
  root,
  onChange,
}: {
  node: TreeNode;
  root: boolean;
  onChange: (transform: (value: TreeNode) => TreeNode) => void;
}) {
  if (node.kind === 'group') {
    return (
      <div className="space-y-2 rounded-lg border bg-white p-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="组合关系" className="min-w-40">
            <select
              className={inputClass}
              value={node.operator}
              onChange={(event) =>
                onChange((value) =>
                  update(value, node.id, (current) => ({
                    ...current,
                    operator: event.target.value as TreeNode['operator'],
                    children:
                      event.target.value === 'NOT'
                        ? (current.children ?? []).slice(0, 1)
                        : current.children,
                  })),
                )
              }
            >
              <option value="AND">全部满足</option>
              <option value="OR">满足任一</option>
              <option value="NOT">条件取反</option>
            </select>
          </Field>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              onChange((value) =>
                update(value, node.id, (current) => ({
                  ...current,
                  children: [...(current.children ?? []), newRuleLeaf()],
                })),
              )
            }
          >
            添加条件
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={node.operator === 'NOT' || (node.children ?? []).length > 8}
            onClick={() =>
              onChange((value) =>
                update(value, node.id, (current) => ({
                  ...current,
                  children: [
                    ...(current.children ?? []),
                    {
                      id: crypto.randomUUID(),
                      kind: 'group',
                      operator: 'AND',
                      children: [newRuleLeaf()],
                    },
                  ],
                })),
              )
            }
          >
            添加条件组
          </Button>
          {!root ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => onChange((value) => remove(value, node.id))}
            >
              删除组
            </Button>
          ) : null}
        </div>
        <div className="space-y-2 border-l-2 border-primary/30 pl-3">
          {(node.children ?? []).map((child) => (
            <Node key={child.id} node={child} root={false} onChange={onChange} />
          ))}
        </div>
      </div>
    );
  }

  const change = (patch: Partial<TreeNode>) =>
    onChange((value) => update(value, node.id, (current) => ({ ...current, ...patch })));

  return (
    <div className="space-y-3 rounded-lg border bg-white p-3">
      <div className="grid items-end gap-2 md:grid-cols-[180px_1fr_auto]">
        <Field label="条件类型">
          <select
            className={inputClass}
            value={node.leafType}
            onChange={(event) => {
              const next = newRuleLeaf(event.target.value as LeafType);
              change({
                leafType: next.leafType,
                value: next.value,
                aliases: next.aliases,
                label: next.label,
                factType: next.factType,
                minimumConfidence: next.minimumConfidence,
              });
            }}
          >
            <option value="tem8">TEM8 专八</option>
            <option value="education">最低学历</option>
            <option value="experience">最低经验</option>
            <option value="boss_tags">BOSS 院校标签</option>
            <option value="keyword">简历关键词</option>
            <option value="semantic">智能识别</option>
          </select>
        </Field>
        {node.leafType === 'education' ? (
          <Field label="最低学历">
            <select
              className={inputClass}
              value={node.value}
              onChange={(event) => change({ value: event.target.value })}
            >
              <option value="associate">专科</option>
              <option value="bachelor">本科</option>
              <option value="master">硕士</option>
              <option value="doctor">博士</option>
            </select>
          </Field>
        ) : node.leafType === 'semantic' ? (
          <Field label="要识别的内容" hint="一次填写一个，例如：跨境电商">
            <input
              className={inputClass}
              value={node.value ?? ''}
              onChange={(event) => change({ value: event.target.value })}
              required
            />
          </Field>
        ) : (
          <Field
            label={
              node.leafType === 'tem8'
                ? '最低置信度'
                : node.leafType === 'experience'
                  ? '最低经验年数'
                  : '条件值'
            }
            hint={node.leafType === 'keyword' || node.leafType === 'boss_tags' ? '多个值用逗号分隔' : undefined}
          >
            <input
              className={inputClass}
              value={node.value ?? ''}
              inputMode={node.leafType === 'tem8' || node.leafType === 'experience' ? 'decimal' : undefined}
              onChange={(event) => change({ value: event.target.value })}
            />
          </Field>
        )}
        <Button type="button" variant="destructive" onClick={() => onChange((value) => remove(value, node.id))}>
          删除
        </Button>
      </div>
      {node.leafType === 'semantic' ? (
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <Field label="筛选要求" hint="例如：具备跨境电商经历">
              <input
                className={inputClass}
                value={node.label ?? ''}
                onChange={(event) => change({ label: event.target.value })}
                required
              />
            </Field>
            <Field label="常见表达（可选）" hint="用逗号分隔，例如：海外电商、出海电商">
              <input
                className={inputClass}
                value={node.aliases ?? ''}
                onChange={(event) => change({ aliases: event.target.value })}
              />
            </Field>
          </div>
          <details className="rounded-lg bg-muted/35 px-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
              高级设置
            </summary>
            <div className="grid gap-2 pb-3 md:grid-cols-2">
              <Field label="内容类别">
                <select
                  className={inputClass}
                  value={node.factType ?? 'skill'}
                  onChange={(event) => change({ factType: event.target.value })}
                >
                  <option value="skill">技能</option>
                  <option value="certificate">证书</option>
                  <option value="industry">行业经历</option>
                  <option value="project">项目经历</option>
                </select>
              </Field>
              <Field label="最低置信度">
                <input
                  className={inputClass}
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={node.minimumConfidence ?? '0.8'}
                  onChange={(event) => change({ minimumConfidence: event.target.value })}
                  required
                />
              </Field>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

export function RuleTreeBuilder({
  value,
  onChange,
}: {
  value: TreeNode;
  onChange: (value: TreeNode) => void;
}) {
  return <Node node={value} root onChange={(transform) => onChange(transform(value))} />;
}
