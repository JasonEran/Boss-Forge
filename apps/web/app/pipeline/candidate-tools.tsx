'use client';
import { Button } from '@/components/ui/button';
import { Field, inputClass } from '../workspace-ui';
import { postJson, Row, stringValue } from '../workspace-utils';
export function CandidateTools({
  stateId,
  users,
  interviews,
  act,
  disabled = false,
}: {
  stateId: string;
  users: Row[];
  interviews: Row[];
  act: (job: () => Promise<unknown>, ok: string) => Promise<void>;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <form
        className="grid gap-2 rounded-lg bg-muted/40 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget),
            starts = new Date(stringValue(f.get('starts')));
          void act(
            () =>
              postJson('/api/collaboration/interviews', {
                stateId,
                startsAt: starts.toISOString(),
                endsAt: new Date(starts.getTime() + 3600000).toISOString(),
                location: f.get('location'),
                participantIds: [f.get('user')],
              }),
            '面试已安排',
          );
        }}
      >
        <b className="text-sm">安排面试</b>
        <Field label="开始时间">
          <input
            className={inputClass}
            name="starts"
            type="datetime-local"
            required
          />
        </Field>
        <Field label="地点或线上链接">
          <input className={inputClass} name="location" />
        </Field>
        <Field label="面试官">
          <select className={inputClass} name="user" required>
            <option value="">选择面试官</option>
            {users.map((u) => (
              <option key={stringValue(u.id)} value={stringValue(u.id)}>
                {stringValue(u.displayName)}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" disabled={disabled}>
          安排 60 分钟
        </Button>
      </form>
      <form
        className="grid gap-2 rounded-lg bg-muted/40 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void act(
            () =>
              postJson(
                '/api/collaboration/states/' + stateId + '/attachments',
                {
                  fileName: f.get('name'),
                  mimeType: 'application/octet-stream',
                  storagePath: f.get('path'),
                  sizeBytes: 0,
                },
              ),
            '附件元数据已登记',
          );
        }}
      >
        <b className="text-sm">登记内网附件</b>
        <Field label="文件名">
          <input className={inputClass} name="name" required />
        </Field>
        <Field label="内网存储路径">
          <input className={inputClass} name="path" required />
        </Field>
        <Button type="submit" variant="outline" disabled={disabled}>
          登记
        </Button>
      </form>
      {interviews.map((i) => (
        <form
          key={stringValue(i.id)}
          className="grid gap-2 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(
              () =>
                postJson(
                  '/api/collaboration/interviews/' +
                    stringValue(i.id) +
                    '/feedback',
                  {
                    recommendation: f.get('recommendation'),
                    score: Number(f.get('score')),
                    strengths: f.get('strengths'),
                    concerns: f.get('concerns'),
                  },
                ),
              '面试反馈已提交',
            );
          }}
        >
          <b className="text-sm">提交面试反馈</b>
          <Field label="建议">
            <select className={inputClass} name="recommendation">
              <option value="yes">建议通过</option>
              <option value="mixed">保留</option>
              <option value="no">不建议</option>
            </select>
          </Field>
          <Field label="评分" hint="1–5 分">
            <input
              className={inputClass}
              name="score"
              type="number"
              inputMode="numeric"
              min="1"
              max="5"
              defaultValue="4"
            />
          </Field>
          <Field label="优势">
            <input className={inputClass} name="strengths" />
          </Field>
          <Field label="顾虑">
            <input className={inputClass} name="concerns" />
          </Field>
          <Button type="submit" disabled={disabled}>
            提交反馈
          </Button>
        </form>
      ))}
    </div>
  );
}
