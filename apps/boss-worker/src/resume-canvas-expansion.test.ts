import { describe, expect, it } from 'vitest';
const { resumeExpansionTarget } = await import(new URL('./resume-canvas-expansion.mjs', import.meta.url).href);
const box = { X: 100, Y: 200, Width: 200, Height: 20 };
describe('visible canvas résumé expansion', () => {
  it('targets a standalone or line-ending expansion button from OCR geometry', () => {
    expect(resumeExpansionTarget({ DetectedText: '查看全部', Confidence: 99, ItemPolygon: box })).toEqual({ x: 260, y: 210, label: '查看全部' });
    expect(resumeExpansionTarget({ DetectedText: '个人优势省略… 查看全部', Confidence: 99, ItemPolygon: box })).toEqual({ x: 260, y: 210, label: '查看全部' });
  });
  it('never selects VIP analysis, contact actions, prose or uncertain OCR', () => {
    for (const DetectedText of ['查看全部 8 项分析', '联系候选人', '打招呼', '工作围绕运营展开', '收起']) {
      expect(resumeExpansionTarget({ DetectedText, Confidence: 99, ItemPolygon: box })).toBeNull();
    }
    expect(resumeExpansionTarget({ DetectedText: '查看全部', Confidence: 30, ItemPolygon: box })).toBeNull();
    expect(resumeExpansionTarget({ DetectedText: '查看全部', Confidence: 99 })).toBeNull();
  });
  it('uses the actual character coordinates when the button shares a long OCR line', () => {
    const Words = [...'长段正文查看全部'].map(Character => ({ Character }));
    const WordCoordPoint = Words.map((_, i) => ({ WordCoordinate: [{ X: 20 + i * 10, Y: 30 }, { X: 30 + i * 10, Y: 30 }, { X: 30 + i * 10, Y: 50 }, { X: 20 + i * 10, Y: 50 }] }));
    expect(resumeExpansionTarget({ DetectedText: '长段正文查看全部', Confidence: 99, ItemPolygon: box, Words, WordCoordPoint })).toEqual({ x: 80, y: 40, label: '查看全部' });
  });
});
