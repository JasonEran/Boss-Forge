export type ResumeScreeningFailure = {
  title: string;
  guidance: string;
  retryable: boolean;
};

export function canRetryResumeScreening(
  status: string,
  message: string | null,
): boolean {
  if (status === 'no_text') return true;
  if (status !== 'failed') return false;
  return describeResumeScreeningFailure(message)?.retryable !== false;
}

export function describeResumeScreeningFailure(
  message: string | null,
): ResumeScreeningFailure | null {
  if (!message) return null;
  if (
    message === 'source_expired' ||
    message === 'target_missing' ||
    message.includes('BOSS_SOURCE_EXPIRED')
  ) {
    return {
      title: '暂未定位到原候选人',
      guidance:
        '系统会返回采集岗位并检查更多已加载卡片；跨天旧任务建议重新采集。这不代表候选人已删除或下线。',
      retryable: true,
    };
  }
  if (message === 'target_changed') {
    return {
      title: '候选人卡片信息已变化',
      guidance:
        '系统为避免看错人没有打开简历。请重新采集该岗位，确认候选人后再处理。',
      retryable: false,
    };
  }
  if (message === 'target_ambiguous') {
    return {
      title: '当前列表存在同名候选人',
      guidance: '系统为避免看错人已停止操作，请人工核对后再处理。',
      retryable: false,
    };
  }
  if (message === 'risk_control') {
    return {
      title: 'BOSS 风控已触发',
      guidance: '系统已停止自动操作。请先由管理员确认账号恢复，不要反复重试。',
      retryable: false,
    };
  }
  if (message === 'content_incomplete' || message.includes('BOSS_RESUME_INCOMPLETE')) {
    return { title: '简历未完整截取', guidance: '部分内容仍在加载或未能展开，系统会稍后重试。本次未使用不完整简历作判断。', retryable: true };
  }
  if (message === 'content_empty') {
    return {
      title: '完整简历内容没有加载出来',
      guidance: '系统会按安全间隔自动重试；若仍失败，可稍后手动重试。',
      retryable: true,
    };
  }
  if (message === 'preview_not_opened') {
    return {
      title: 'BOSS 未打开完整简历',
      guidance: '可能是页面暂未加载完成或查看权益受限，可稍后重试一次。',
      retryable: true,
    };
  }
  if (message === 'ocr_failed') {
    return {
      title: '简历文字识别失败',
      guidance: '系统保留了失败原因，可稍后重试；若持续失败，请人工查看简历。',
      retryable: true,
    };
  }
  if (message === 'historical_result_needs_recheck') {
    return {
      title: '该候选人的历史结果需按当前规则复核',
      guidance: '系统不会直接沿用旧结论，请等待或发起重新精筛。',
      retryable: true,
    };
  }
  if (message === 'worker_error') {
    return {
      title: '简历处理程序暂时异常',
      guidance: '系统可重试；若再次失败，请管理员检查运行状态。',
      retryable: true,
    };
  }
  if (message.includes('BOSS_TARGET_MISSING')) {
    return {
      title: '暂未定位到原候选人',
      guidance:
        '系统会返回采集岗位并检查更多已加载卡片；跨天旧任务建议重新采集。这不代表候选人已删除或下线。',
      retryable: true,
    };
  }
  if (message.includes('BOSS_TARGET_CHANGED')) {
    return {
      title: '候选人卡片信息已变化',
      guidance:
        '系统为避免看错人没有打开简历。请重新采集该岗位，确认候选人后再处理。',
      retryable: false,
    };
  }
  if (message.includes('BOSS_TARGET_AMBIGUOUS')) {
    return {
      title: '当前列表存在同名候选人',
      guidance: '系统为避免看错人已停止操作，请人工核对后再处理。',
      retryable: false,
    };
  }
  if (message.includes('c-resume') || message.includes('在线简历 iframe')) {
    return {
      title: 'BOSS 未打开完整简历',
      guidance: '可能是页面暂未加载完成或查看权益受限，可稍后重试一次。',
      retryable: true,
    };
  }
  if (message.includes('BOSS_RESUME_CONTENT_EMPTY')) {
    return {
      title: '完整简历内容没有加载出来',
      guidance:
        '系统已拦截空白截图，请稍后重新精筛，不会再把空白页面标成 OCR 无正文。',
      retryable: true,
    };
  }
  if (message.includes('missing or ambiguous')) {
    return {
      title: '旧版候选人定位失败',
      guidance: '重复卡片误判已修复，可以重新精筛。',
      retryable: true,
    };
  }
  return {
    title: '简历精筛未完成',
    guidance: '可以重新精筛；若仍失败，系统会显示更具体的原因。',
    retryable: true,
  };
}
