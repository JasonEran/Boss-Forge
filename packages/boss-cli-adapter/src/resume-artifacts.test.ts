import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readResumeArtifact, readResumePart, resolveResumeFile } from './resume-artifacts.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'boss-resume-test-')); dirs.push(dir);
  const png = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(900,16); png.writeUInt32BE(1600,20);
  const path = join(dir, 'resume.png'); await writeFile(path, png); await writeFile(join(dir,'resume-part-002.png'), png);
  const manifest = { version:1,complete:true,capturedAt:'2026-09-07T00:00:00Z',contentHeight:3120,contentWidth:900,parts:[
    {file:'resume.png',width:900,height:1600,offsetY:0,cssHeight:1600,overlapTop:0},
    {file:'resume-part-002.png',width:900,height:1600,offsetY:1520,cssHeight:1600,overlapTop:80}
  ] };
  await writeFile(path+'.manifest.json',JSON.stringify(manifest)); return {dir,path,manifest};
}
describe('complete résumé artifacts', () => {
  it('reads all ordered parts and explicitly identifies legacy captures',async()=>{
    const {path}=await fixture(); const result=await readResumeArtifact(path); expect(result.complete).toBe(true);
    expect((await readResumePart(path,result,1)).length).toBe(32);
    await rm(path+'.manifest.json');expect((await readResumeArtifact(path)).complete).toBe(false);
  });
  it('rejects missing bottom, gaps, path traversal and changed dimensions',async()=>{
    const {path,manifest}=await fixture();
    for(const changed of [{...manifest,contentHeight:4000},{...manifest,parts:[manifest.parts[0],{...manifest.parts[1],offsetY:1800}]},{...manifest,parts:[{...manifest.parts[0],file:'../resume.png'}]}]) {
      await writeFile(path+'.manifest.json',JSON.stringify(changed)); await expect(readResumeArtifact(path)).rejects.toThrow(/BOSS_RESUME_INCOMPLETE/);
    }
    await expect(readResumePart(path,{...manifest,version:1,parts:[{...manifest.parts[0]!,height:1500}]},0)).rejects.toThrow(/尺寸/);
  });
  it('rejects a missing part or a symlink outside the screenshot directory',async()=>{
    const {path,dir}=await fixture(), second=await fixture();const artifact=await readResumeArtifact(path);
    await rm(join(dir,'resume-part-002.png'));await expect(readResumePart(path,artifact,1)).rejects.toThrow();
    await symlink(second.path,join(dir,'escape.png'));await expect(resolveResumeFile(join(dir,'escape.png'),dir)).rejects.toThrow(/目录/);
  });
});
