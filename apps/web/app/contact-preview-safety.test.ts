import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./contact-preview-dialog.tsx', import.meta.url),
  'utf8',
);

describe('contact preview safety boundary', () => {
  it('binds explicit real-contact confirmation to one final action preview', () => {
    expect(source).toContain('confirmRealContact: true');
    expect(source).toContain('contactPreviewApprovalToken: approvalToken');
    expect(source).not.toContain('/api/automation/readiness');
    expect(source).toContain(
      "verifiedMode.state === 'real' && approval !== null",
    );
    expect(source).toContain('readiness?.contactDispatchMode');
    expect(source).toContain(
      'disabled={!preview || submitting || !canConfirm}',
    );
    expect(source).toContain('confirm()');
    expect(source).toContain('!canConfirm');
    expect(source).toContain('actionKind,');
    expect(source).toContain('${stateId}/${actionKind}-preview');
    expect(source).toContain('payload.preview.actionKind !== actionKind');
    expect(source).toContain('payload.approval.actionKind !== actionKind');
    expect(source).toContain('确认并仅向');
    expect(source).toContain('以上候选人唯一标识、发件账号、岗位、任务和正文');
    expect(source).toContain('{actionLabel}预览与人工确认');
  });

  it('shows one server-consistent recipient and readiness evidence package', () => {
    expect(source).toContain('payload.readiness.candidate.candidateId');
    expect(source).toContain('payload.preview.candidateId');
    expect(source).toContain('payload.readiness.position.bossAccountId');
    expect(source).toContain('payload.preview.bossAccountId');
    expect(source).toContain('payload.readiness.source.stableLocatorPresent');
    expect(source).toContain('payload.preview.sourceLocatorSha256');
    expect(source).toContain('payload.approval.renderedMessageSha256');
    expect(source).toContain('唯一记录');
    expect(source).toContain('发件 BOSS 账号');
    expect(source).toContain('正文指纹');
    expect(source).toContain('单次许可');
    expect(source).toContain('本次{actionLabel}安全检查');
    expect(source).toContain('任一信息变化后必须重新预览确认');
    expect(source).toContain('发送处理程序未启动');
    expect(source).toContain('本次${actionLabel}尚未通过全部安全检查');
    expect(source).toContain('联系运行状态无法确认，系统已阻止创建任务');
    expect(source).toContain("loading\n                  ? '正在生成预览'");
    expect(source).toContain("error\n                    ? '当前不可创建'");
  });

  it('keeps greet and message request shapes independent', () => {
    expect(source).toContain("actionKind === 'greet'");
    expect(source).toContain('templateVersionId: null');
    expect(source).toContain('providerJobId: preview.providerJobId');
    expect(source).toContain('providerGreetingId: preview.providerGreetingId');
    expect(source).toContain(
      'renderedMessageSha256: preview.renderedMessageSha256',
    );
    expect(source).toContain(
      '{ templateVersionId: preview.templateVersionId }',
    );
    expect(source).toContain('BOSS 岗位专属招呼语');
    expect(source).toContain('providerJobName');
    expect(source).toContain('greet_exact_content_unavailable');
    expect(source).toContain('在 BOSS 岗位设置中配置专属招呼语');
    expect(source).toContain('系统没有创建任务');
  });

  it('requires an explicit, recipient-bound acknowledgement for real contact only', () => {
    expect(source).toContain('realContactAcknowledged');
    expect(source).toContain('checked={realContactAcknowledged}');
    expect(source).toContain('setRealContactAcknowledged(checked === true)');
    expect(source).toContain(
      'if (!nextOpen) setRealContactAcknowledged(false)',
    );
    expect(source).toContain('if (!nextOpen && submitting) return');
    expect(source).toContain('onOpenChange={handleOpenChange}');
    expect(source).toContain('showCloseButton={!submitting}');
    expect(source).toContain('disabled={submitting}');
    expect(source).toContain('setLoadedScopeKey(null)');
    expect(source).toContain('setRealContactAcknowledged(false)');
    expect(source).toContain(
      'readyToCreate && (!verifiedRealContact || realContactAcknowledged)',
    );
    expect(source).toContain('真实{actionLabel}前的最终确认');
    expect(source).toContain('我已核对本次动作是“{actionLabel}”');
    expect(source).toContain('{preview.candidateName}');
    expect(source).toContain('{preview.bossAccountId}');
    expect(source).toContain('{preview.positionName}');
    expect(source).toContain('{preview.taskId.slice(0, 8)}');
    expect(source).toContain('和上方最终正文');
    expect(source).toContain('可能立即执行，且无法从本系统撤回');
    expect(source).toContain('打招呼`');
    expect(source).toContain('发送这一条`');
    expect(source).toContain(
      "variant={verifiedRealContact ? 'destructive' : 'default'}",
    );
  });
});
