import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboard = readFileSync(
  new URL('./dashboard-client.tsx', import.meta.url),
  'utf8',
);

describe('contact action UI', () => {
  it('offers greet and message as separate preview actions', () => {
    expect(dashboard).toMatch(
      /openContactPreview\(\s*candidate\.stateId,\s*'greet'/u,
    );
    expect(dashboard).toMatch(
      /openContactPreview\(\s*candidate\.stateId,\s*'message'/u,
    );
    expect(dashboard).toContain('打招呼');
    expect(dashboard).toContain('发消息');
    expect(dashboard).toContain('actionKind={contactActionKind}');
    expect(dashboard).toContain('不会连带执行另一项');
    expect(dashboard).toContain('联系安全设置');
    expect(dashboard).toContain('不在这里执行联系');
    expect(dashboard).toContain('contactMode.detail');
  });

  it('shows the action kind in candidate and execution status', () => {
    expect(dashboard).toContain("intent.actionKind === 'greet'");
    expect(dashboard).toContain("intent.actionKind === 'message'");
    expect(dashboard).toContain('contactActionLabel[intent.actionKind]');
    expect(dashboard).toContain('<TableHead>动作</TableHead>');
  });

  it('replaces name-only confirm with an exact high-risk verification dialog', () => {
    expect(dashboard).not.toContain(
      '请先在 BOSS 消息列表中核验“${intent.candidateName}”',
    );
    expect(dashboard).toContain('<AlertDialog');
    expect(dashboard).toContain('contactVerificationAcknowledged');
    expect(dashboard).toContain('此操作本身不会联系候选人');
    expect(dashboard).toContain('当时确认的最终正文');
    expect(dashboard).toContain('确认已核验未执行并解除锁定');
    expect(dashboard).toContain('缺少候选人定位指纹，系统已阻止解除锁定');
  });

  it('attests every immutable intent field when resolving uncertainty', () => {
    for (const field of [
      'expectedVersion: intent.version',
      'actionKind: intent.actionKind',
      'candidateStateId: intent.candidateStateId',
      'candidateId: intent.candidateId',
      'candidateName: intent.candidateName',
      'taskId: intent.taskId',
      'bossAccountId: intent.bossAccountId',
      'templateVersionId: intent.templateVersionId',
      'providerJobId: intent.providerJobId',
      'providerGreetingId: intent.providerGreetingId',
      'renderedMessageSha256: intent.renderedMessageSha256',
      'sourceLocatorSha256: intent.sourceLocatorSha256',
    ]) {
      expect(dashboard).toContain(field);
    }
    expect(dashboard).toContain("'content-type': 'application/json'");
    expect(dashboard).toContain('!intent.sourceLocatorSha256');
  });
});
