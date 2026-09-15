import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createDatabase } from './client.js';
import { assertIsolatedTestDatabase } from './test-safety.js';

// This test deliberately requires an empty disposable database, never a
// downgrade of an existing installation. No browser or worker is started.
assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
const sql = createDatabase();
try {
  const [tables] =
    await sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`;
  assert.equal(tables!.n, 0, 'A new, empty disposable database is required.');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith('.sql') && n.slice(0, 3) <= '037')
    .sort()) {
    const content = await readFile(new URL(name, directory), 'utf8');
    await sql.begin((tx) => tx.unsafe(content));
  }
  const department = randomUUID(),
    user = randomUUID(),
    candidate = randomUUID(),
    orphan = randomUUID();
  const message = randomUUID(),
    orphanMessage = randomUUID();
  const time = '2026-09-01T01:00:00.000Z';
  await sql`INSERT INTO departments(id,slug,name) VALUES(${department},'chat-upgrade-test','隔离升级测试')`;
  await sql`INSERT INTO users(id,department_id,email,display_name,role)
    VALUES(${user},${department},'upgrade@example.invalid','隔离测试管理员','admin')`;
  await sql`INSERT INTO candidates(id,fingerprint,display_name) VALUES
    (${candidate},'chat-upgrade-one','旧会话示例'),(${orphan},'chat-upgrade-orphan','旧消息示例')`;
  await sql`INSERT INTO communication_threads(candidate_id,boss_account_id,geek_id,provider_conversation_id,unread_count,preview,preview_sent_at,synced_at)
    VALUES(${candidate},'upgrade-test-account','upgrade-geek-one','old-conversation',2,'原有消息',${time},${time})`;
  await sql`INSERT INTO communication_messages(id,candidate_id,boss_account_id,geek_id,provider_message_id,direction,body,status,sent_at,received_at)
    VALUES(${message},${candidate},'upgrade-test-account','upgrade-geek-one','old-mid','inbound','原有消息','sent',${time},${time}),
    (${orphanMessage},${orphan},'upgrade-test-account','upgrade-geek-orphan','orphan-mid','inbound','尚无会话行的旧消息','sent',${time},${time})`;
  await sql`INSERT INTO communication_reads(candidate_id,user_id,read_through) VALUES(${candidate},${user},${time})`;
  const migration = await readFile(
    new URL('038_boss_communication_inbox.sql', directory),
    'utf8',
  );
  await sql.begin((tx) => tx.unsafe(migration));

  const [thread] =
    await sql`SELECT * FROM communication_threads WHERE id=${candidate}`;
  assert.equal(thread!.candidate_id, candidate);
  assert.equal(thread!.candidate_name, '旧会话示例');
  assert.equal(thread!.provider_conversation_id, 'old-conversation');
  assert.equal(thread!.unread_count, 2);
  assert.equal(thread!.preview, '原有消息');
  assert.equal(new Date(thread!.preview_sent_at).toISOString(), time);
  const [old] =
    await sql`SELECT * FROM communication_messages WHERE id=${message}`;
  assert.equal(old!.conversation_id, candidate);
  assert.equal(old!.candidate_id, candidate);
  assert.equal(old!.provider_message_id, 'old-mid');
  assert.equal(old!.body, '原有消息');
  const [read] =
    await sql`SELECT * FROM communication_reads WHERE conversation_id=${candidate} AND user_id=${user}`;
  assert.equal(new Date(read!.read_through).toISOString(), time);
  assert.equal(
    (
      await sql`SELECT conversation_id FROM communication_messages WHERE id=${orphanMessage}`
    )[0]!.conversation_id,
    orphan,
  );
  assert.equal(
    (
      await sql`SELECT candidate_name FROM communication_threads WHERE id=${orphan}`
    )[0]!.candidate_name,
    '旧消息示例',
  );

  const native = randomUUID();
  await sql`INSERT INTO communication_threads(id,candidate_name,boss_account_id,geek_id)
    VALUES(${native},'仅在 BOSS 沟通','upgrade-test-account','upgrade-geek-native')`;
  await sql`INSERT INTO communication_messages(id,conversation_id,boss_account_id,geek_id,direction,body,status)
    VALUES(${randomUUID()},${native},'upgrade-test-account','upgrade-geek-native','inbound','不创建筛选候选人','sent')`;
  await sql`INSERT INTO communication_reads(conversation_id,user_id,read_through) VALUES(${native},${user},now())`;
  assert.equal((await sql`SELECT count(*)::int AS n FROM candidates`)[0]!.n, 2);
  assert.equal(
    (
      await sql`SELECT candidate_id FROM communication_threads WHERE id=${native}`
    )[0]!.candidate_id,
    null,
  );
  console.log(
    JSON.stringify({
      ok: true,
      upgrade037to038: true,
      legacyConversationIdsPreserved: true,
      messagesPreserved: true,
      readMarkersPreserved: true,
      orphanMessagesBackfilled: true,
      nativeConversationsIndependent: true,
      externalContactExecuted: false,
    }),
  );
} finally {
  await sql.end();
}
