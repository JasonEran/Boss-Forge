'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CircleHelp,
  FileUser,
  LoaderCircle,
  RefreshCw,
  X,
  CircleAlert,
} from 'lucide-react';
import type {
  CommunicationCandidateContext,
  BossSharedContact,
} from '../../../../packages/contracts/src/communication';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { apiFetch, controlApi, userFacingRequestError } from '../api-client';
import { SharedContacts } from './message-assets';

type Props = {
  conversationId: string;
  name: string;
  tab: 'resume' | 'requirements';
  onTab(this: void, tab: 'resume' | 'requirements'): void;
  onClose(this: void): void;
  context: CommunicationCandidateContext | null;
  contextError: string;
  onAnalyze(this: void): Promise<void>;
  onRead(this: void): Promise<CommunicationCandidateContext>;
  canRead: boolean;
  canInsert: boolean;
  onInsert(this: void, body: string): void;
  onLifecycle(this: void): void;
  contacts: BossSharedContact[];
  wechatReason?: string | null;
  resumeReason?: string | null;
};
function ResumePart({
  conversationId,
  resume,
  part,
}: {
  conversationId: string;
  resume: NonNullable<CommunicationCandidateContext['resume']>;
  part: NonNullable<CommunicationCandidateContext['resume']>['parts'][number];
}) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    void apiFetch(
      `${controlApi}/api/communication/conversations/${conversationId}/online-resume/${part.index}?capture=${resume.captureId}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (!r.ok) throw Error('图片读取失败');
        const blob = await r.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, part.index, resume.captureId]);
  return <div className="relative w-full bg-white" style={{aspectRatio:`${part.width} / ${part.height}`}}>
    {src ? <a className="block" href={src} target="_blank" rel="noreferrer" title="打开原尺寸简历">
      {/* eslint-disable-next-line @next/next/no-img-element -- Private authenticated image. Dimensions reserve the final layout before it loads. */}
      <img src={src} width={part.width} height={part.height} alt={`在线简历，第 ${part.index+1} 段，点击放大`} className="h-auto w-full"/>
    </a> : <p className="absolute inset-0 flex items-center justify-center p-4 text-xs text-slate-600">
      {failed?'图片读取失败，请重新打开资料栏。':'正在加载简历图片…'}
    </p>}
  </div>;

}
export function CandidateContextPanel(props: Props) {
  const {conversationId,onClose}=props;
  const data=props.context?.conversationId===conversationId?props.context:null;
  const loading=!data&&!props.contextError;
  const [analyzing,setAnalyzing]=useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [wide, setWide] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const media = matchMedia('(min-width: 1280px)');
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  async function read() {
    if (reading || !props.canRead) return;
    setReading(true);
    setError('');
    try {
      await props.onRead();
    } catch (e) {
      if (mounted.current) setError(userFacingRequestError(e));
    } finally {
      if (mounted.current) setReading(false);
    }
  }
  const content = (
    <>
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <h2 className="truncate text-sm font-semibold">
          {props.name} · 候选人资料
        </h2>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 min-w-11"
          aria-label="收起候选人资料"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div
        className="flex shrink-0 gap-1 border-b px-3"
        aria-label="候选人资料视图"
      >
        <Button
          variant={props.tab === 'resume' ? 'secondary' : 'ghost'}
          className="min-h-11"
          onClick={() => props.onTab('resume')}
          aria-pressed={props.tab === 'resume'}
        >
          在线简历
        </Button>
        <Button
          variant={props.tab === 'requirements' ? 'secondary' : 'ghost'}
          className="min-h-11"
          onClick={() => props.onTab('requirements')}
          aria-pressed={props.tab === 'requirements'}
        >
          岗位要求
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3">
        {error || props.contextError ? (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error || props.contextError}
          </p>
        ) : null}
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {data?.resume ? '已保存在线简历' : '读取当前人的在线简历'}
            </p>
            <Button
              type="button"
              variant={data?.resume ? 'outline' : 'default'}
              className="min-h-11 text-xs"
              disabled={!props.canRead || reading || loading}
              onClick={() => void read()}
            >
              {reading ? (
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              ) : data?.resume ? (
                <RefreshCw className="size-4" />
              ) : (
                <FileUser className="size-4" />
              )}
              {reading
                ? '正在读取…'
                : data?.resume
                  ? '更新简历'
                  : '从 BOSS 读取'}
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {reading
              ? '正在加载并保存完整截图，加载完成后查看约 10 秒；截图会先显示，识别与岗位分析在后台继续。'
              : data?.resume
                ? `读取于 ${new Date(data.resume.capturedAt).toLocaleString('zh-CN')}，可点击图片放大。`
                : '先显示完整截图，再在后台识别文字并核对岗位要求。'}
          </p>
          {!props.canRead && !reading ? (
            <p className="text-xs text-muted-foreground">
              连接 BOSS 并等待当前操作完成后可读取。已有内容仍可查看。
            </p>
          ) : null}
        </div>
        {loading ? (
          <output className="text-sm text-muted-foreground">
            正在读取候选人资料…
          </output>
        ) : props.tab === 'resume' ? (
          <>
            {data?.resume ? (
              <>
                <AnalysisState resume={data.resume} busy={analyzing} onRetry={async()=>{
                  if(analyzing)return;setAnalyzing(true);setError('');
                  try{await props.onAnalyze();}catch(e){if(mounted.current)setError(userFacingRequestError(e));}
                  finally{if(mounted.current)setAnalyzing(false);}
                }}/>
                {data.resume.parts.map((part) => (
                  <ResumePart
                    key={`${data.resume!.captureId}:${part.index}`}
                    conversationId={conversationId}
                    resume={data.resume!}
                    part={part}
                  />
                ))}
                {data.resume.text ? (
                  <details className="rounded-lg border p-3">
                    <summary className="min-h-11 cursor-pointer text-sm">
                      查看识别文字
                    </summary>
                    <p className="whitespace-pre-wrap break-words text-sm leading-7">
                      {data.resume.text}
                    </p>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="py-8 text-center text-sm leading-6 text-muted-foreground">
                读取后可在这里查看完整简历，
                <br />
                并核对专八等岗位要求。
              </p>
            )}
            <SharedContacts contacts={props.contacts} />
            {props.wechatReason || props.resumeReason ? (
              <details className="rounded-lg border p-3">
                <summary className="min-h-11 cursor-pointer text-sm">
                  联系与附件状态
                </summary>
                <p className="text-xs leading-6 text-muted-foreground">
                  {props.wechatReason}
                  <br />
                  {props.resumeReason}
                </p>
              </details>
            ) : null}
          </>
        ) : (
          <>
            {data?.resume ? <AnalysisState resume={data.resume} busy={analyzing} onRetry={async()=>{
              if(analyzing)return;setAnalyzing(true);setError('');
              try{await props.onAnalyze();}catch(e){if(mounted.current)setError(userFacingRequestError(e));}
              finally{if(mounted.current)setAnalyzing(false);}
            }}/> : null}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">
                {data?.positionId ? data.positionName : '尚未关联平台岗位'}
              </h3>
              <p className="text-xs leading-5 text-muted-foreground">
                {data?.ruleVersion
                  ? `当前岗位条件 · 版本 ${data.ruleVersion}。`
                  : '尚无可核对的岗位条件。'}
                主动联系不代表已通过筛选。以下仅整理简历证据，未提到不等于不满足。
              </p>
              {!data?.positionId ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={props.onLifecycle}
                >
                  关联岗位并跟进
                </Button>
              ) : null}
            </div>
            {data?.requirements.length ? (
              data.requirements.map((item) => (
                <article
                  key={item.id}
                  className="space-y-2 rounded-lg border p-3"
                >
                  <p className="text-[11px] text-muted-foreground">
                    {item.group}
                  </p>
                  <h4 className="text-sm font-medium">{item.label}</h4>
                  <p
                    className={`flex items-center gap-1.5 text-xs font-medium ${item.status === 'positive' ? 'text-emerald-700 dark:text-emerald-300' : item.status === 'negative' ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground'}`}
                  >
                    {item.status === 'positive' ? (
                      <Check className="size-4" />
                    ) : item.status === 'negative' ? (
                      <CircleAlert className="size-4" />
                    ) : (
                      <CircleHelp className="size-4" />
                    )}
                    {item.status === 'positive'
                      ? '有符合证据'
                      : item.status === 'negative'
                        ? '有不符证据'
                        : '待确认'}
                  </p>
                  {item.evidence.map((e, index) => (
                    <blockquote
                      key={index}
                      className="border-l-2 pl-2 text-xs leading-6"
                    >
                      {e}
                    </blockquote>
                  ))}
                  <p className="text-xs leading-5 text-muted-foreground">
                    {item.explanation}
                  </p>
                  <Button
                    variant="outline"
                    className="min-h-11 text-xs"
                    disabled={!props.canInsert}
                    onClick={() => props.onInsert(item.question)}
                  >
                    插入确认问题
                  </Button>
                </article>
              ))
            ) : (
              <p className="rounded-lg bg-muted p-3 text-sm leading-6">
                请先在岗位设置中配置需要核对的证书、学历或经验条件。
              </p>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              确认问题只会填入输入框，可编辑后发送；核对结果不会自动淘汰或推进候选人。
            </p>
          </>
        )}
      </div>
    </>
  );
  return wide ? (
    <aside
      aria-label="候选人资料"
      className="flex min-h-0 w-[340px] shrink-0 flex-col border-l bg-card 2xl:w-[380px]"
    >
      {content}
    </aside>
  ) : (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        showCloseButton={false}
        className="!h-dvh !w-full !max-w-lg gap-0"
      >
        <SheetTitle className="sr-only">{props.name}的候选人资料</SheetTitle>
        <SheetDescription className="sr-only">
          在线简历与岗位要求核对
        </SheetDescription>
        {content}
      </SheetContent>
    </Sheet>
  );
}

function AnalysisState({resume,busy,onRetry}:{resume:NonNullable<CommunicationCandidateContext['resume']>;busy:boolean;onRetry(this:void):Promise<void>}) {
  const pending=['pending','processing'].includes(resume.textStatus);
  return <div aria-live="polite" className="space-y-2 rounded-lg bg-muted p-3 text-xs leading-5">
    <p>{pending?'截图已显示，正在后台识别并分析岗位要求，完成后自动更新。':resume.textStatus==='ready'?'简历分析已完成，可在「岗位要求」查看结果。':resume.analysisError||'截图已保存，可继续分析并核对岗位要求。'}</p>
    {pending?<span className="inline-flex items-center gap-1.5 text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none"/>可以继续查看简历或聊天</span>:resume.textStatus!=='ready'?<Button type="button" variant="outline" className="min-h-11 text-xs" disabled={busy} onClick={()=>void onRetry()}>{busy?'正在开始…':resume.textStatus==='skipped'?'继续分析':'重试分析'}</Button>:null}
  </div>;
}
