import { BossForgeRepository, M2Repository, createDatabase } from "@boss-forge/data";

async function main(): Promise<void> {
  const sql = createDatabase();
  try {
    const repository = new BossForgeRepository(sql);
    const m2Repository = new M2Repository(sql);
    const position = await repository.createPosition({
      bossAccountId: process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01",
      name: "当前登录岗位",
      bossJobKeyword: null,
      ownerName: "HR 管理员"
    });
    const version = await repository.createRuleVersion({
      positionId: position.id,
      name: "英语专业八级硬性条件",
      config: {
        requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.86 }]
      },
      dictionaryVersion: "2026.09.1",
      createdBy: "system:m1-seed"
    });
    const templateVersionId = await m2Repository.ensureMessageTemplate({
      name: "默认人工联系模板",
      body: "你好 {{candidate_name}}，我们正在招聘{{position_name}}，看到你的经历与岗位比较匹配，方便进一步沟通吗？",
      createdBy: "system:m2-seed"
    });
    console.log(JSON.stringify({ ok: true, position, version, templateVersionId }, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
