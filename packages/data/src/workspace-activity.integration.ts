/** Disposable database only. No BOSS browser or external message calls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertIsolatedTestDatabase, createDatabase, DepartmentAtsRepository, WorkspaceActivityRepository, type SessionPrincipal } from './index.js';

assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
const sql = createDatabase();
try {
  const ats = new DepartmentAtsRepository(sql), activity = new WorkspaceActivityRepository(sql);
  await ats.ensureBootstrap({ departmentName: 'Activity fixture', adminEmail: 'activity@example.invalid', adminName: 'Activity fixture', password: 'DisposableActivity123!' });
  const u = (await sql`select * from users where email='activity@example.invalid'`)[0]!;
  const principal: SessionPrincipal = { userId: u.id, departmentId: u.department_id, email: u.email, displayName: u.display_name, role: u.role };
  const account = 'activity-test';
  await ats.createAssignedPosition(principal, { bossAccountId: account, name: 'Activity fixture', ownerName: 'Fixture' });
  const a = randomUUID(), b = randomUUID();
  assert.equal(await activity.communicationActive(account), false);
  assert.equal(await activity.update(principal, account, a, 'enter'), true);
  assert.equal(await activity.communicationActive(account), true);
  assert.equal(await activity.leaseActive('another-account', a), false);
  assert.equal(await activity.leaseActive(account, a, randomUUID()), false);
  assert.equal(await activity.update(principal, account, b, 'enter'), true);
  assert.equal(await activity.update(principal, account, a, 'leave'), false);
  assert.equal(await activity.communicationActive(account), true, 'Another open communication page keeps screening paused');
  assert.equal(await activity.update(principal, account, a, 'renew'), false, 'A late heartbeat cannot undo leave');
  assert.equal(await activity.update(principal, account, a, 'enter'), false, 'A duplicate enter cannot undo leave');
  await activity.update(principal, account, b, 'leave');
  assert.equal(await activity.communicationActive(account), false);
  const delayed = randomUUID();
  await activity.update(principal, account, delayed, 'leave');
  assert.equal(await activity.update(principal, account, delayed, 'enter'), false, 'Leave before enter leaves a tombstone');
  const expired = randomUUID();
  await activity.update(principal, account, expired, 'enter');
  await sql`update communication_browser_leases set expires_at=now()-interval '1 second' where id=${expired}`;
  assert.equal(await activity.communicationActive(account), false, 'Closed/crashed pages expire without an explicit leave');
  assert.equal(await activity.update(principal, account, expired, 'renew'), false, 'Late renew cannot steal the browser back');
  await assert.rejects(activity.update({ ...principal, role: 'interviewer' }, account, randomUUID(), 'enter'), /权限/);
  await assert.rejects(activity.update({ ...principal, departmentId: randomUUID() }, account, randomUUID(), 'enter'), /权限/);
  assert.equal((await sql`select count(*)::int as n from contact_intents`)[0]!.n, 0);
  console.log(JSON.stringify({ ok: true, enterLeave: true, multiplePages: true, outOfOrderRequests: true, disconnectedPageExpires: true, accountAndUserIsolation: true, realMessagesSent: 0 }));
} finally { await sql.end(); }
