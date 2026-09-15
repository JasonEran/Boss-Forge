import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readResumeArtifact, readResumePart, resolveResumeFile } from '@boss-forge/boss-cli-adapter';
import type { CommunicationRepository, SessionPrincipal } from '@boss-forge/data';
import type { CommunicationCandidateContext } from '@boss-forge/contracts';
import { communicationQualifications, communicationQualificationSummary } from './communication-qualification.js';

export async function communicationResumeFile(repository: CommunicationRepository, principal: SessionPrincipal, id: string) {
  const snapshot = await repository.onlineResume(principal, id);
  if (!snapshot) return null;
  const file = await resolveResumeFile(snapshot.screenshotPath, process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR?.trim() || join(homedir(),'.boss-cli','.cache','resume-screenshots'));
  const artifact = await readResumeArtifact(file);
  const captureId = createHash('sha256').update(file).digest('hex').slice(0,24);
  return {snapshot,file,artifact,captureId};
}
export async function communicationCandidateContext(repository: CommunicationRepository, principal: SessionPrincipal, id: string): Promise<CommunicationCandidateContext> {
  const {target,rule} = await repository.onlineResumeRule(principal,id);
  const stored = await communicationResumeFile(repository,principal,id);
  if (stored) for (let i=0;i<stored.artifact.parts.length;i++) await readResumePart(stored.file,stored.artifact,i);
  const requirements = communicationQualifications(rule?.config ?? null, stored?.snapshot.text ?? '');
  return {conversationId:id,positionId:target.positionId,positionName:target.positionName,ruleVersion:rule?.version ?? null,
    resume:stored ? {captureId:stored.captureId,capturedAt:stored.snapshot.capturedAt,text:stored.snapshot.text,textStatus:stored.snapshot.textStatus,analysisVersion:stored.snapshot.analysisVersion ?? 0,analysisError:stored.snapshot.analysisError ?? null,complete:stored.artifact.complete,parts:stored.artifact.parts.map((p,index)=>({index,width:p.width,height:p.height}))} : null,
    requirements, qualification:communicationQualificationSummary(rule?.config ?? null,requirements)};
}
