'use client';

import { useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Flag,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AuthGate, useCurrentUser } from '../auth-gate';
import { NativeLink as Link } from '../native-link';
import { WorkspaceShell } from '../workspace-shell';
import { useGuide } from '../onboarding/guide-state';
import {
  guidePracticeHref,
  updateGuideProgress,
} from '../onboarding/guide-progress';
import type { GuideStep } from '../onboarding/guide-content';

function KnowledgeCheck({ quiz }: { quiz: NonNullable<GuideStep['quiz']> }) {
  const [answer, setAnswer] = useState<number | null>(null);
  return (
    <section
      aria-label="小练习"
      className="rounded-xl border bg-muted/30 p-4 sm:p-5"
    >
      <p className="text-xs font-semibold text-primary">想一想 · 可选小练习</p>
      <p className="mb-3 mt-2 text-sm font-medium leading-6">{quiz.question}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {quiz.options.map((option, index) => (
          <button
            key={option}
            type="button"
            aria-pressed={answer === index}
            onClick={() => setAnswer(index)}
            className={`flex min-h-12 items-center gap-3 rounded-lg border px-3 py-3 text-left text-sm leading-6 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${answer === index ? 'border-primary bg-secondary text-primary' : 'bg-card hover:border-primary/40'}`}
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full border text-xs">
              {answer === index ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : (
                String.fromCharCode(65 + index)
              )}
            </span>
            {option}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {answer !== null ? (
          <p
            className={`mt-3 text-sm leading-6 ${answer === quiz.correct ? 'text-success' : 'text-foreground'}`}
          >
            <span className="font-semibold">
              {answer === quiz.correct ? '理解正确。' : '再留意一下：'}
            </span>
            {quiz.explanation}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function GuideLearning() {
  const { progress, ready, saved, steps, dispatch } = useGuide();
  const user = useCurrentUser();
  const lessonHeading = useRef<HTMLHeadingElement>(null);
  const step = steps.find((item) => item.id === progress.current)!;
  const index = steps.indexOf(step);
  const complete = progress.completed.length === steps.length;
  const learned = progress.completed.includes(step.id);
  const [showRestart, setShowRestart] = useState(false);
  const [mobileContents, setMobileContents] = useState(false);

  function focusLesson() {
    window.requestAnimationFrame(() => {
      lessonHeading.current?.focus({ preventScroll: true });
      lessonHeading.current?.scrollIntoView({
        block: 'start',
        behavior: 'instant',
      });
    });
  }
  function select(id: string) {
    dispatch({ type: 'select', id });
    setMobileContents(false);
    focusLesson();
  }
  function learnAndContinue() {
    dispatch({ type: 'complete', id: step.id });
    focusLesson();
  }

  if (!ready)
    return (
      <output className="block rounded-xl border bg-card p-6 text-sm text-muted-foreground">
        正在读取你的学习进度…
      </output>
    );

  return (
    <div className="space-y-5">
      <section
        aria-label="导览进度"
        className="rounded-xl border bg-card p-4 sm:px-6 sm:py-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-secondary text-primary">
              <BookOpen className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold">
                {user.role === 'interviewer'
                  ? '面试官的候选人协作路径'
                  : '从第一份招聘需求，到下一位合适的人'}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {steps.length} 个章节 · 阅读约{' '}
                {steps.reduce((sum, item) => sum + item.minutes, 0)} 分钟 ·
                可跳读、可随时暂停
              </p>
            </div>
          </div>
          <span
            aria-live="polite"
            className="text-sm font-medium tabular-nums text-primary"
          >
            已了解 {progress.completed.length} / {steps.length}
          </span>
        </div>
        <progress
          aria-label="新手导览学习进度"
          value={progress.completed.length}
          max={steps.length}
          aria-valuetext={`已了解 ${progress.completed.length} 个章节，共 ${steps.length} 个章节`}
          className="sr-only"
        />
        <div aria-hidden="true" className="mt-4 flex gap-1.5">
          {steps.map((item) => (
            <span
              key={item.id}
              className={`h-1.5 flex-1 rounded-full ${progress.completed.includes(item.id) ? 'bg-primary' : 'bg-muted'}`}
            />
          ))}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {saved
            ? '进度按当前账号保存在此浏览器。点击“已了解”只标记学习进度，实际招聘操作在对应页面完成。'
            : '此浏览器无法保存学习进度，刷新或离开后可能需要重新选择章节；仍可正常阅读导览。'}
        </p>
      </section>

      {complete ? (
        <section
          aria-label="已完成导览"
          className="flex flex-col gap-4 rounded-xl border border-success/25 bg-success/5 p-5 sm:flex-row sm:items-center"
        >
          <CheckCircle2
            className="size-8 shrink-0 text-success"
            aria-hidden="true"
          />
          <div className="flex-1">
            <h2 className="font-semibold">导览已完成，开始你的招聘工作</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {user.role === 'interviewer'
                ? '核对候选人证据 → 确认面试安排 → 记录反馈。'
                : '每天先看任务与待审核，再跟进联系和面试，最后检查异常与招聘数据。'}
              需要时仍可从下方目录温习。
            </p>
          </div>
          <Button
            nativeButton={false}
            className="min-h-11"
            render={
              <Link
                href={user.role === 'interviewer' ? '/pipeline' : '/tasks'}
              />
            }
          >
            进入工作
            <ArrowRight />
          </Button>
        </section>
      ) : null}

      <div className="grid items-start gap-5 xl:grid-cols-[252px_minmax(0,1fr)]">
        <aside
          className="overflow-hidden rounded-xl border bg-card xl:sticky xl:top-20"
          aria-label="导览章节"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">你的学习路径</p>
            <button
              type="button"
              className="flex min-h-11 items-center gap-1 text-sm text-primary xl:hidden"
              aria-expanded={mobileContents}
              aria-controls="guide-chapters"
              onClick={() => setMobileContents(!mobileContents)}
            >
              {mobileContents ? '收起' : `第 ${index + 1} 章 · 展开`}
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>
            <span className="hidden text-xs text-muted-foreground xl:block">
              按需跳读
            </span>
          </div>
          <nav
            id="guide-chapters"
            aria-label="选择导览章节"
            className={`${mobileContents ? 'block' : 'hidden'} p-2 xl:block`}
          >
            <ol>
              {steps.map((item, itemIndex) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={item.id === step.id ? 'step' : undefined}
                    onClick={() => select(item.id)}
                    className={`flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary ${item.id === step.id ? 'bg-secondary text-primary' : 'hover:bg-muted'}`}
                  >
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-medium ${progress.completed.includes(item.id) ? 'bg-primary text-white' : item.id === step.id ? 'border border-primary/30 bg-card' : 'border text-muted-foreground'}`}
                    >
                      {progress.completed.includes(item.id) ? (
                        <>
                          <Check className="size-3.5" aria-hidden="true" />
                          <span className="sr-only">已了解</span>
                        </>
                      ) : (
                        String(itemIndex + 1).padStart(2, '0')
                      )}
                    </span>
                    <span>
                      <span className="block text-sm font-medium leading-5">
                        {item.title}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {item.phase}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <div className="border-t p-3">
            {showRestart ? (
              <div className="space-y-2">
                <p className="px-1 text-xs leading-5 text-muted-foreground">
                  清空本账号在此浏览器的学习标记，从第一章开始。
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setShowRestart(false)}
                  >
                    保留进度
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11"
                    onClick={() => {
                      dispatch({ type: 'reset' });
                      setShowRestart(false);
                      focusLesson();
                    }}
                  >
                    重新开始
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 w-full justify-start text-muted-foreground"
                onClick={() => setShowRestart(true)}
              >
                <RotateCcw />
                重新学习
              </Button>
            )}
          </div>
        </aside>

        <article
          aria-labelledby="guide-lesson-title"
          className="min-w-0 overflow-hidden rounded-xl border bg-card"
        >
          <div className="border-b px-5 py-5 sm:px-7 sm:py-6">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold text-primary">
                第 {String(index + 1).padStart(2, '0')} 章 · {step.phase}
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <Clock3 className="size-3.5" aria-hidden="true" />约{' '}
                {step.minutes} 分钟
              </span>
              {learned ? (
                <span className="flex items-center gap-1 text-success">
                  <Check className="size-3.5" aria-hidden="true" />
                  已了解
                </span>
              ) : null}
            </div>
            <h2
              id="guide-lesson-title"
              ref={lessonHeading}
              tabIndex={-1}
              className="scroll-mt-40 text-xl font-semibold tracking-tight outline-none lg:scroll-mt-24"
            >
              {step.title}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
              {step.purpose}
            </p>
          </div>

          <div className="space-y-6 px-5 py-6 sm:px-7">
            <section aria-label="招聘场景示意">
              <p className="mb-3 text-xs font-medium text-muted-foreground">
                用一个场景理解 · 仅作说明
              </p>
              <dl className="grid gap-2 sm:grid-cols-3">
                {step.example.map((item, exampleIndex) => (
                  <div
                    key={item.label}
                    className="relative rounded-lg border bg-muted/25 px-4 py-3"
                  >
                    <dt className="text-xs text-muted-foreground">
                      {item.label}
                    </dt>
                    <dd className="mt-1.5 pr-2 text-sm font-medium leading-6">
                      {item.value}
                    </dd>
                    {exampleIndex < step.example.length - 1 ? (
                      <ArrowRight
                        className="absolute -right-3 top-1/2 z-10 hidden size-4 -translate-y-1/2 bg-card text-muted-foreground sm:block"
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>
                ))}
              </dl>
            </section>
            <section aria-label="操作步骤">
              <h3 className="mb-4 text-sm font-semibold">跟着这三步做</h3>
              <ol className="space-y-5">
                {step.steps.map((item, itemIndex) => (
                  <li key={item.title} className="flex gap-3 sm:gap-4">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-primary">
                      {itemIndex + 1}
                    </span>
                    <div>
                      <h4 className="text-sm font-semibold leading-7">
                        {item.title}
                      </h4>
                      <p className="mt-1 text-sm leading-7 text-muted-foreground">
                        {item.detail}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section
              className="flex gap-3 rounded-xl bg-secondary/60 p-4"
              aria-label="本章目标"
            >
              <Flag
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <div>
                <h3 className="text-sm font-semibold">做到这里，就掌握了</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {step.outcome}
                </p>
              </div>
            </section>
            <details key={`faq-${step.id}`} className="group rounded-xl border">
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary">
                <CircleHelp
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="flex-1 leading-6">{step.question}</span>
                <ChevronDown
                  className="size-4 shrink-0 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <p className="border-t px-4 py-3 text-sm leading-7 text-muted-foreground">
                {step.answer}
              </p>
            </details>
            {step.quiz ? (
              <KnowledgeCheck key={step.id} quiz={step.quiz} />
            ) : null}
          </div>

          <div className="space-y-4 border-t bg-muted/20 px-5 py-5 sm:px-7">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                nativeButton={false}
                variant="outline"
                className="min-h-11 bg-card px-4"
                render={
                  <Link
                    href={guidePracticeHref(step.target.href, step.id)}
                    onClick={() => dispatch({ type: 'practice', id: step.id })}
                  />
                }
              >
                <BookOpen />
                {step.target.label}
                <ArrowRight />
              </Button>
              <span className="text-xs leading-5 text-muted-foreground">
                进入真实页面后，顶部会保留本章操作提示。
              </span>
            </div>
            {step.related?.length ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {step.related.map((link) => (
                  <Link
                    key={link.href}
                    href={guidePracticeHref(link.href, step.id)}
                    className="inline-flex min-h-11 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
                  >
                    {link.label}
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </Link>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                disabled={index === 0}
                onClick={() => select(steps[index - 1]!.id)}
              >
                <ArrowLeft />
                上一章
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  nativeButton={false}
                  variant="ghost"
                  className="min-h-11 text-muted-foreground"
                  render={
                    <Link
                      href="/"
                      onClick={() => dispatch({ type: 'pause' })}
                    />
                  }
                >
                  暂时离开
                </Button>
                <Button
                  type="button"
                  className="min-h-11 px-4"
                  onClick={learnAndContinue}
                >
                  {complete
                    ? '本章已了解'
                    : updateGuideProgress(
                          progress,
                          { type: 'complete', id: step.id },
                          user.role,
                        ).completed.length === steps.length
                      ? '完成导览'
                      : '我已了解，下一章'}
                  {complete ? <Check /> : <ArrowRight />}
                </Button>
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}

export function GuideClient() {
  return (
    <AuthGate>
      <WorkspaceShell
        current="/guide"
        title="HR 详细手册"
        description="按需查阅完整步骤和常见问题。想跟着页面快速上手，点击侧栏的新手导览。"
        actions={
          <Button
            nativeButton={false}
            variant="outline"
            className="min-h-11"
            render={<Link href="/" />}
          >
            <ArrowLeft />
            返回工作台
          </Button>
        }
      >
        <GuideLearning />
      </WorkspaceShell>
    </AuthGate>
  );
}
