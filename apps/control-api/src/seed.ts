import { BossForgeRepository, createDatabase } from "@boss-forge/data";

async function main(): Promise<void> {
  const sql = createDatabase();
  try {
    const repository = new BossForgeRepository(sql);
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
      dictionaryVersion: "2026.08.1",
      createdBy: "system:m1-seed"
    });
    console.log(JSON.stringify({ ok: true, position, version }, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
