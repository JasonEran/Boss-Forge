import { createInstitutionCatalog } from "./institution-catalog.js";
import type {
  InstitutionCatalog,
  InstitutionCatalogDraft,
  InstitutionCatalogStatus
} from "./institution-types.js";

export const TEST_CATALOG_VERSION = "cn-institution-test-2026.01";

export function institutionCatalogDraft(options: {
  version?: string;
  status?: InstitutionCatalogStatus;
} = {}): InstitutionCatalogDraft {
  return {
    schemaVersion: "1.0",
    version: options.version ?? TEST_CATALOG_VERSION,
    status: options.status ?? "published",
    source: {
      name: "Reviewed deterministic test fixture",
      asOfDate: "2026-01-01"
    },
    importedBy: "test-importer",
    reviewedBy: "test-reviewer",
    publishedAt: "2026-01-02T00:00:00.000Z",
    changeSummary: "Test fixture only; not a production institution list.",
    institutions: [
      {
        id: "inst-peking",
        standardName: "北京大学",
        countryOrRegion: "CN",
        kind: "university",
        categories: ["project_985", "project_211", "double_first_class_university"],
        aliases: [
          { id: "alias-peking-abbr", value: "北大", kind: "abbreviation" },
          { id: "alias-peking-en", value: "Peking University", kind: "english_name" },
          { id: "alias-peking-former", value: "京师大学堂", kind: "former_name" },
          { id: "alias-peking-ocr", value: "北京大學", kind: "ocr_variant" },
          {
            id: "alias-peking-shenzhen",
            value: "北京大学深圳研究生院",
            kind: "campus_mapping"
          }
        ]
      },
      {
        id: "inst-985-only",
        standardName: "甲示范大学",
        countryOrRegion: "CN",
        kind: "university",
        categories: ["project_985"],
        aliases: []
      },
      {
        id: "inst-211-only",
        standardName: "乙示范大学",
        countryOrRegion: "CN",
        kind: "university",
        categories: ["project_211"],
        aliases: [{ id: "alias-211-only", value: "乙大", kind: "abbreviation" }]
      },
      {
        id: "inst-discipline",
        standardName: "学科示范大学",
        countryOrRegion: "CN",
        kind: "university",
        categories: ["double_first_class_discipline"],
        doubleFirstClassDisciplines: ["计算机科学与技术", "材料科学与工程"],
        aliases: []
      },
      {
        id: "inst-independent",
        standardName: "北京大学独立学院",
        countryOrRegion: "CN",
        kind: "independent_college",
        categories: ["other_domestic"],
        aliases: []
      },
      {
        id: "inst-normal",
        standardName: "普通示范学院",
        countryOrRegion: "CN",
        kind: "college",
        categories: ["other_domestic"],
        aliases: []
      },
      {
        id: "inst-city-a",
        standardName: "东城大学",
        countryOrRegion: "CN",
        kind: "university",
        categories: ["other_domestic"],
        aliases: [{ id: "alias-city-a", value: "城大", kind: "abbreviation" }]
      },
      {
        id: "inst-city-b",
        standardName: "西城大学",
        countryOrRegion: "CN",
        kind: "university",
        categories: ["other_domestic"],
        aliases: [{ id: "alias-city-b", value: "城大", kind: "abbreviation" }]
      }
    ]
  };
}

export function buildInstitutionCatalog(options: {
  version?: string;
  status?: InstitutionCatalogStatus;
} = {}): InstitutionCatalog {
  return createInstitutionCatalog(institutionCatalogDraft(options));
}
