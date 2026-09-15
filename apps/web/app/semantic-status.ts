export type SemanticSummary = {
  mode: 'off' | 'shadow' | 'active' | null;
  total: number;
  matched: number;
  notMatched: number;
  unknown: number;
  modelError: boolean;
};

type ResumeScreeningStatus =
  | 'not_requested'
  | 'queued'
  | 'processing'
  | 'screened'
  | 'no_text'
  | 'failed';

export type SemanticDisplayStatus = {
  label: string;
  detail: string;
  emphasized: boolean;
};

export type SemanticProviderReadiness = {
  enabled: boolean;
  ready: boolean;
  reason:
    | 'ready'
    | 'disabled'
    | 'missing_endpoint'
    | 'invalid_endpoint'
    | 'missing_model'
    | 'missing_credential'
    | 'invalid_timeout';
  endpointHost: string | null;
  model: string | null;
  fallbackModel?: string | null;
  credentialConfigured: boolean;
  timeoutMs: number | null;
};

export function semanticProviderDisplayStatus(
  input: SemanticProviderReadiness,
): { label: string; detail: string; ready: boolean } {
  const configuredTarget = [
    input.endpointHost,
    input.model,
    input.fallbackModel ? `兜底 ${input.fallbackModel}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (input.ready) {
    return {
      label: '模型配置完整',
      detail: `${configuredTarget || '已完成安全配置'}；连通性会在试运行时验证，结果不改变筛选结论。`,
      ready: true,
    };
  }
  const detailByReason: Record<SemanticProviderReadiness['reason'], string> = {
    ready: '模型连接已就绪。',
    disabled: '模型连接当前关闭；系统只使用确定性规则和已维护的常见表达。',
    missing_endpoint: '尚未配置模型连接地址，系统不会发出模型请求。',
    invalid_endpoint: '模型连接地址不安全或格式错误，系统已拒绝连接。',
    missing_model: '尚未配置模型名称，系统不会发出模型请求。',
    missing_credential: '尚未配置新的模型密钥，系统不会发出模型请求。',
    invalid_timeout: '模型等待时间配置无效，系统已拒绝连接。',
  };
  return {
    label: input.reason === 'disabled' ? '模型连接未启用' : '模型连接未就绪',
    detail: detailByReason[input.reason],
    ready: false,
  };
}

export function semanticDisplayStatus(input: {
  resumeScreeningStatus: ResumeScreeningStatus;
  semanticSummary: SemanticSummary;
}): SemanticDisplayStatus {
  const { resumeScreeningStatus, semanticSummary } = input;

  if (semanticSummary.total > 0) {
    const resultParts = [
      semanticSummary.matched > 0 ? `符合 ${semanticSummary.matched}` : null,
      semanticSummary.notMatched > 0
        ? `不符合 ${semanticSummary.notMatched}`
        : null,
      semanticSummary.unknown > 0 ? `待确认 ${semanticSummary.unknown}` : null,
    ].filter((item): item is string => Boolean(item));
    if (semanticSummary.mode === 'off') {
      return {
        label: `未启用 · ${semanticSummary.total} 项解释记录`,
        detail: `仅供查看，不影响筛选${resultParts.length ? ` · ${resultParts.join(' · ')}` : ''}`,
        emphasized: false,
      };
    }
    const modeLabel =
      semanticSummary.mode === 'active'
        ? '已生效'
        : semanticSummary.mode === 'shadow'
          ? '试运行'
          : '模式未知';

    return {
      label: semanticSummary.modelError
        ? `${modeLabel} · 有异常`
        : `${modeLabel} · ${semanticSummary.total} 项`,
      detail: semanticSummary.modelError
        ? `模型未完成，筛选结论未受影响${resultParts.length ? ` · ${resultParts.join(' · ')}` : ''}`
        : resultParts.join(' · ') || '等待人工确认',
      emphasized:
        semanticSummary.mode === 'active' && !semanticSummary.modelError,
    };
  }

  if (resumeScreeningStatus === 'failed') {
    return { label: '未运行', detail: '简历读取失败', emphasized: false };
  }
  if (resumeScreeningStatus === 'no_text') {
    return {
      label: '无法识别',
      detail: '简历中没有可读正文',
      emphasized: false,
    };
  }
  if (
    resumeScreeningStatus === 'queued' ||
    resumeScreeningStatus === 'processing'
  ) {
    return {
      label: '等待识别',
      detail: '简历读取完成后运行',
      emphasized: false,
    };
  }
  if (resumeScreeningStatus === 'screened') {
    return {
      label: '无需识别',
      detail: '当前规则未使用智能条件',
      emphasized: false,
    };
  }
  return { label: '未安排', detail: '尚未开始简历精筛', emphasized: false };
}
