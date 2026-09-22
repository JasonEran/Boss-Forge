'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { MAX_SCREENING_LIMIT } from '../../../packages/contracts/src/screening-limit';

export function validScreeningCount(value: string): boolean {
  return (
    /^\d+$/u.test(value) &&
    Number(value) >= 1 &&
    Number(value) <= MAX_SCREENING_LIMIT
  );
}

export function ScreeningCountField({
  id,
  value,
  onChange,
  disabled = false,
  scheduled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  scheduled?: boolean;
}) {
  const valid = validScreeningCount(value);
  return (
    <div className="w-full space-y-2 rounded-lg border bg-muted/20 p-3 text-left">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {scheduled ? '每次打招呼人数' : '本次打招呼人数'}
        </label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_SCREENING_LIMIT}
          step={1}
          aria-label={scheduled ? '每次打招呼人数' : '本次打招呼人数'}
          className="h-11 w-24"
          value={value}
          disabled={disabled}
          required
          aria-invalid={!valid}
          aria-describedby={`${id}-hint${valid ? '' : ` ${id}-error`}`}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="text-sm text-muted-foreground">人</span>
        {[10, 20, 50, 100, 200, 500].map((count) => (
          <Button
            key={count}
            type="button"
            variant={Number(value) === count ? 'secondary' : 'outline'}
            className="h-11 min-w-11"
            aria-pressed={Number(value) === count}
            disabled={disabled}
            onClick={() => onChange(String(count))}
          >
            {count}
          </Button>
        ))}
      </div>
      <p
        id={`${id}-hint`}
        className="max-w-full text-xs leading-5 break-words text-muted-foreground"
      >
        这里填的是成功发出的打招呼人数，不是筛简历人数。系统仍按最多 20
        人一批筛选并自动打招呼，直到成功打招呼达到该人数，或推荐列表确认没有新人。账号每天最多
        200 个打招呼（含已发出和还在队列里的）。未通过的简历不计入打招呼人数。
      </p>
      {!valid ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          请输入不小于 1 的整数人数。
        </p>
      ) : null}
    </div>
  );
}
