const EDUCATION_HEADING = /^(?:教育经历|教育背景|学历经历|education(?:\s+(?:background|history))?)\s*[:：]?\s*/iu;
const OTHER_HEADING = /^(?:工作经历|工作经验|实习经历|项目经历|项目经验|社团经历|在校实践|所获荣誉|资格证书|专业技能|个人优势|求职期望|自我评价|培训经历|志愿者经历|牛人分析器|work\s+experience|projects|skills|certifications)\s*[:：]?/iu;
const SCHOOL = /(?:大学|学院|学校|中学|\buniversity\b|\bcollege\b|\bschool\b)/iu;
const DATE_RANGE = /(?<!\d)((?:19|20)\d{2})(?:[./年](?:0?[1-9]|1[0-2])月?)?\s*[-–—~～至]\s*((?:19|20)\d{2})(?:[./年](?:0?[1-9]|1[0-2])月?)?(?![\d./])/u;
const ENTRY_DESCRIPTION = /^(?:在校经历|在校表现|主修课程|经历描述|毕设\s*\/\s*论文|毕业论文|毕业设计|描述)\s*[:：]?/u;
const SCHOOL_BADGE = /^(?:QS\s*(?:世界)?大学|(?:世界)?大学排[名行]|(?:985|211)院校|双一流院校|省部共建|卓越工程师计划)/iu;
const DEGREE = /(?:本科|专科|大专|学士|硕士|博士|\bbachelor\b|\bmaster\b|\bph\.?d\b|\bdegree\b)/iu;

/** Keep dates and enrollment status bound to school entry headers. */
function educationPeriods(text: string) {
  const lines = text.normalize("NFKC").split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const periods: Array<{ year: number; sourceText: string }> = [];
  const ongoing: string[] = [];
  let inEducation = false;
  let inDescription = false;
  let entry: string[] = [];
  let unresolved = false;
  const finishEntry = () => {
    if (!entry.length) return;
    const sourceText = entry.join("\n");
    if (/(?:至今|在读|未毕业|肄业|退学|present|ongoing|dropped\s+out)/iu.test(sourceText)) {
      unresolved = true;
      if (/(?:至今|在读|未毕业|present|ongoing)/iu.test(sourceText)) ongoing.push(sourceText);
    } else {
      const range = sourceText.match(DATE_RANGE);
      if (range) {
        const start = Number(range[1]), end = Number(range[2]);
        if (end > start && end - start <= 15) periods.push({ year: end, sourceText });
        else unresolved = true;
      } else {
        // A later degree with an unreadable period must not inherit an older year.
        unresolved = true;
      }
    }
    entry = [];
  };
  for (const [index, originalLine] of lines.entries()) {
    let line = originalLine;
    if (EDUCATION_HEADING.test(line)) {
      finishEntry();
      inEducation = true;
      inDescription = false;
      line = line.replace(EDUCATION_HEADING, "");
    } else if (OTHER_HEADING.test(line)) {
      finishEntry();
      inEducation = false;
    }
    if (!inEducation || !line) continue;
    if (ENTRY_DESCRIPTION.test(line)) {
      finishEntry();
      inDescription = true;
      continue;
    }
    const schoolHeader = line.length <= 100 && SCHOOL.test(line) &&
      !SCHOOL_BADGE.test(line) &&
      !/[。！？；]|学生会|社团|活动|有限公司|出版社/u.test(line);
    // Descriptions can mention schools and dates without introducing a degree.
    // A subsequent school entry must have its own degree/period header.
    const followingHeader = lines.slice(index + 1, index + 6).filter((value, offset, following) =>
      !following.slice(0, offset + 1).some(value => ENTRY_DESCRIPTION.test(value) || OTHER_HEADING.test(value) || SCHOOL.test(value))
    ).join("\n");
    const startsSchool = schoolHeader && (!inDescription || DEGREE.test(line) ||
      (DEGREE.test(followingHeader) && /(?:19|20)\d{2}/u.test(followingHeader)));
    if (startsSchool) {
      finishEntry();
      inDescription = false;
      entry = [line];
    } else if (!inDescription && entry.length) {
      if (entry.length < 7 && entry.join("").length + line.length <= 250) entry.push(line);
      else finishEntry();
    }
  }
  finishEntry();
  return { periods, unresolved, ongoing };
}

export function ongoingEducationEvidence(text: string): string[] {
  return educationPeriods(text).ongoing;
}

/** School end years are a fallback for an unlabeled graduation year. */
export function educationPeriodEndYear(text: string): { value: string; sourceText: string } | null {
  const { periods, unresolved } = educationPeriods(text);
  if (unresolved || !periods.length) return null;
  const latest = periods.reduce((a, b) => a.year >= b.year ? a : b);
  return { value: String(latest.year), sourceText: `教育经历（结束年份）：${latest.sourceText}` };
}
