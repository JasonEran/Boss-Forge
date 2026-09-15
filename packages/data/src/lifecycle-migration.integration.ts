import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertIsolatedTestDatabase,
  createDatabase,
  DepartmentAtsRepository,
  BossForgeRepository,
  CommunicationRepository,
  type SessionPrincipal,
} from './index.js';
assertIsolatedTestDatabase(process.env, { contactSideEffects: true });
const sql = createDatabase();
try {
  const [existing] =
    await sql`SELECT to_regclass('public.schema_migrations') AS name`;
  assert.equal(existing!.name, null, 'Use an empty disposable database');
  await sql`CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),checksum text)`;
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith('.sql') && n < '039')
    .sort()) {
    const content = await readFile(new URL(name, dir), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${createHash('sha256').update(content).digest('hex')})`;
    });
  }
  const ats = new DepartmentAtsRepository(sql),
    repo = new BossForgeRepository(sql),
    chat = new CommunicationRepository(sql);
  await ats.ensureBootstrap({
    departmentName: '升级验收',
    adminEmail: 'migration-test@example.com',
    adminName: '升级验收管理员',
    password: 'Migration-Test-Only!',
  });
  const [u] = await sql`SELECT * FROM users WHERE role='admin' LIMIT 1`;
  const principal: SessionPrincipal = {
    userId: u!.id,
    departmentId: u!.department_id,
    email: u!.email,
    displayName: u!.display_name,
    role: 'admin',
  };
  const accountId = `migration-lifecycle-${randomUUID()}`,
    position = await repo.createPosition({
      bossAccountId: accountId,
      name: '旧版沟通岗位',
      ownerName: principal.displayName,
    });
  await sql`UPDATE positions SET department_id=${principal.departmentId},owner_user_id=${principal.userId},boss_job_id='migration-job' WHERE id=${position.id}`;
  await chat.saveInbox(accountId, {
    fetchedAt: new Date().toISOString(),
    conversations: [
      {
        geekId: 'migration-lifecycle-geek',
        candidateName: '旧版会话（虚构验收）',
        bossJobId: 'migration-job',
        preview: '升级前的回复',
        lastMessageAt: new Date().toISOString(),
        timeLabel: '刚刚',
        unreadCount: 1,
      },
    ],
  });
  const target = (await chat.targets(principal)).find(
    (t) => t.bossAccountId === accountId,
  )!;
  const messageId = randomUUID(),
    actionId = randomUUID();
  await sql`INSERT INTO communication_messages(id,conversation_id,boss_account_id,geek_id,provider_message_id,provider_conversation_id,direction,kind,body,status,sent_at) VALUES(${messageId},${target.id},${accountId},${target.geekId},'old-message','old-thread','inbound','text','升级前的回复','sent',now())`;
  await sql`INSERT INTO communication_wechat_actions(id,conversation_id,boss_account_id,geek_id,sender_id,client_request_id,status) VALUES(${actionId},${target.id},${accountId},${target.geekId},${principal.userId},${randomUUID()},'failed')`;
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./migrate.ts', import.meta.url)),
    ],
    { env: process.env, stdio: 'pipe' },
  );
  assert.equal(
    (await chat.thread(principal, target.id)).messages[0]!.body,
    '升级前的回复',
  );
  assert.deepEqual(
    (
      await sql`SELECT assets FROM communication_messages WHERE id=${messageId}`
    )[0]!.assets,
    [],
  );
  assert.equal(
    (
      await sql`SELECT action_kind FROM communication_wechat_actions WHERE id=${actionId}`
    )[0]!.action_kind,
    'wechat',
  );
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./migrate.ts', import.meta.url)),
    ],
    { env: process.env, stdio: 'pipe' },
  );
  console.log(
    'PASS: 038 native inbox/messages/actions upgraded through 039 without data loss; repeated migration is idempotent and checksum-verified.',
  );
} finally {
  await sql.end();
}
