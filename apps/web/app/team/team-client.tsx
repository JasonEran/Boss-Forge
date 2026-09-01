'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AuthGate } from '../auth-gate';
import { WorkspaceShell } from '../workspace-shell';
import { Empty, inputClass, Notice, Panel } from '../workspace-ui';
import { apiJson, postJson, Row, rows, stringValue } from '../workspace-utils';

function TeamContent() {
  const [data, setData] = useState<Row>({}); const [error, setError] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(await apiJson<Row>('/api/department/workspace')); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const users = rows(data.users); const positions = rows(data.positions); const members = rows(data.members); const stages = rows(data.stages);
  async function action(work: () => Promise<unknown>, success: string) { try { await work(); setMessage(success); setError(null); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }
  return <WorkspaceShell current="/team" title="团队与岗位权限" description="管理部门账号、岗位负责人/协作者以及可配置招聘阶段。服务端对所有岗位资源执行相同权限校验。">
    <Notice error={error} message={message} />
    <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      <Panel title="部门成员" description="管理员与招聘负责人可创建和停用账号。">
        <div className="space-y-2">{users.length ? users.map((user) => <div key={stringValue(user.id)} className="flex flex-wrap items-center gap-3 rounded-lg border p-3"><div className="min-w-52 flex-1"><p className="font-medium">{stringValue(user.displayName)}</p><p className="text-xs text-muted-foreground">{stringValue(user.email)}</p></div><Badge variant="outline">{stringValue(user.role)}</Badge><Badge variant={user.status === 'active' ? 'default' : 'secondary'}>{stringValue(user.status)}</Badge><Button size="sm" variant="outline" onClick={() => void action(() => postJson(`/api/team/users/${stringValue(user.id)}/status`, { status: user.status === 'active' ? 'disabled' : 'active' }), '账号状态已更新')}>{user.status === 'active' ? '停用' : '启用'}</Button></div>) : <Empty />}</div>
        <form className="grid gap-3 rounded-xl bg-muted/40 p-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void action(() => postJson('/api/team/users', { email: f.get('email'), displayName: f.get('displayName'), role: f.get('role'), password: f.get('password') }), '成员已创建'); }}>
          <input className={inputClass} name="displayName" placeholder="姓名" required /><input className={inputClass} name="email" type="email" placeholder="内部邮箱" required />
          <select className={inputClass} name="role" defaultValue="recruiter"><option value="recruiter">HR</option><option value="recruiting_lead">招聘负责人</option><option value="interviewer">面试官</option><option value="admin">管理员</option></select><input className={inputClass} name="password" type="password" placeholder="初始密码（至少12位）" required />
          <Button className="md:col-span-2">创建成员</Button>
        </form>
      </Panel>
      <Panel title="岗位协作者" description="成员只能看到被分配岗位；负责人可看到部门全部岗位。">
        {members.length ? members.map((item) => <div key={stringValue(item.positionId)+"-"+stringValue(item.userId)} className="flex justify-between rounded-lg border p-3 text-sm"><span>{stringValue(item.displayName)}</span><Badge variant="outline">{stringValue(item.memberRole)}</Badge></div>) : <Empty />}
        <form className="space-y-3 rounded-xl bg-muted/40 p-4" onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); const positionId = stringValue(f.get('positionId')); void action(() => postJson(`/api/positions/${positionId}/members`, { userId: f.get('userId'), memberRole: f.get('memberRole') }), '岗位成员已分配'); }}>
          <select className={inputClass} name="positionId" required><option value="">选择岗位</option>{positions.map((p) => <option key={stringValue(p.id)} value={stringValue(p.id)}>{stringValue(p.name)}</option>)}</select>
          <select className={inputClass} name="userId" required><option value="">选择成员</option>{users.map((u) => <option key={stringValue(u.id)} value={stringValue(u.id)}>{stringValue(u.displayName)}</option>)}</select>
          <select className={inputClass} name="memberRole" defaultValue="recruiter"><option value="owner">负责人</option><option value="recruiter">HR</option><option value="interviewer">面试官</option><option value="viewer">只读</option></select><Button>保存分配</Button>
        </form>
      </Panel>
    </div>
    <Panel title="招聘阶段配置" description="各岗位申请独立保存阶段，同一自然人可处于不同岗位的不同阶段。">
      <div className="flex flex-wrap gap-2">{stages.map((stage) => <Badge key={stringValue(stage.id)} variant="outline">{String(stage.order)} · {stringValue(stage.label)}{stage.terminal ? '（终态）' : ''}</Badge>)}</div>
      <form className="grid gap-3 md:grid-cols-5" onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void action(() => postJson('/api/pipeline/stages', { key: f.get('key'), label: f.get('label'), order: Number(f.get('order')), terminal: f.get('terminal') === 'on' }), '招聘阶段已保存'); }}>
        <input className={inputClass} name="key" placeholder="stage_key" required /><input className={inputClass} name="label" placeholder="显示名称" required /><input className={inputClass} name="order" type="number" min="1" placeholder="顺序" required /><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="terminal" />终态</label><Button>保存阶段</Button>
      </form>
    </Panel>
  </WorkspaceShell>;
}
export function TeamClient() { return <AuthGate><TeamContent /></AuthGate>; }
