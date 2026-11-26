import type { VaultMap, PiiCategory } from './vaultMap';
import { getLocalPiiModel } from '../firebase/aiLogic';

type ContextualCategory = Extract<PiiCategory, 'PERSON' | 'ADDRESS' | 'ORG' | 'FINANCIAL'>;

// FIX 1: On-device Nano aksar NAME/LOCATION/COMPANY likh deta hai — unhe valid categories mein map karo
const CATEGORY_ALIASES: Record<string, ContextualCategory> = {
  PERSON: 'PERSON',
  NAME: 'PERSON',
  NAMES: 'PERSON',
  'PERSONAL NAME': 'PERSON',
  'PERSONAL NAMES': 'PERSON',
  ADDRESS: 'ADDRESS',
  LOCATION: 'ADDRESS',
  LOCATIONS: 'ADDRESS',
  CITY: 'ADDRESS',
  ORG: 'ORG',
  ORGANIZATION: 'ORG',
  ORGANIZATIONS: 'ORG',
  COMPANY: 'ORG',
  COMPANIES: 'ORG',
  EMPLOYER: 'ORG',
  UNIVERSITY: 'ORG',
  SCHOOL: 'ORG',
  FINANCIAL: 'FINANCIAL',
  MONEY: 'FINANCIAL',
  AMOUNT: 'FINANCIAL',
  SALARY: 'FINANCIAL',
};

const BLOCKED_LABELS: ReadonlySet<string> = new Set([
  'employee',
  'employer',
  'name',
  'address',
  'residential address',
  'annual ctc',
  'ctc',
  'inr',
  'rs',
  'usd',
  'pan',
  'aadhaar',
  'phone',
  'email',
  'upi',
  'ifsc',
  'salary',
  'bond',
  'clause',
  'summary',
  'skills',
  'education',
  'experience',
  'projects',
  'linkedin',
  'github',
  'none',
  'n/a',
  'na',
  'null',
  'not found',
  'unknown',
]);

interface ExtractedEntity {
  text: string;
  category: ContextualCategory;
}

export interface LocalScanResult {
  sanitizedText: string;
  addedRedactions: number;
  engineStatus: 'on-device-success' | 'on-device-unavailable' | 'on-device-error';
  latencyMs: number;
  note?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveCategory(raw: string): ContextualCategory | null {
  const normalized = raw.replace(/[*`#:_-]+$/g, '').replace(/^[*`#]+/g, '').trim().toUpperCase();
  return CATEGORY_ALIASES[normalized] ?? null;
}

function isValidEntity(rawText: string, rawCategory: string): ExtractedEntity | null {
  const text = rawText.replace(/^["'`*]+|["'`*]+$/g, '').trim();
  const category = resolveCategory(rawCategory);

  if (!category || text.length < 3 || /\[[A-Z_]+_\d+\]/.test(text)) return null;
  if (BLOCKED_LABELS.has(text.toLowerCase())) return null;

  if (
    category === 'FINANCIAL' &&
    !(/\d/.test(text) && /(?:inr|rs\.?|₹|\$|€|£|,\d{2,3}|\.\d{2})/i.test(text))
  ) {
    return null;
  }

  return { text, category };
}

// FIX 2: Inline (PERSON|Value, NAME: Value) + Grouped Markdown (**PERSON:**\n- Value) + JSON teeno parse honge
function parseEntities(rawOutput: string): ExtractedEntity[] {
  const cleaned = rawOutput
    .replace(/^```(?:json|text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const valid: ExtractedEntity[] = [];
  let activeGroupCategory: ContextualCategory | null = null;

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Case 1: Section heading line (e.g. "**PERSON:**" or "Locations:")
    const headingMatch = trimmed.match(/^#{0,3}\s*\*{0,2}([A-Za-z\s]{3,20})\*{0,2}\s*:?\s*$/);
    if (headingMatch) {
      const groupCat = resolveCategory(headingMatch[1]);
      if (groupCat) {
        activeGroupCategory = groupCat;
        continue;
      }
    }

    const line = trimmed.replace(/^[-*•\d.)\s]+/, '').trim();

    // Case 2: Inline "CATEGORY|EXACT_TEXT" or "CATEGORY: EXACT_TEXT"
    const inlineMatch = line.match(/^\*{0,2}([A-Za-z\s]{3,20})\*{0,2}\s*[|:\-–]\s*(.+)$/);
    if (inlineMatch) {
      const entity = isValidEntity(inlineMatch[2], inlineMatch[1]);
      if (entity) {
        valid.push(entity);
        continue;
      }
    }

    // Case 3: Bullet item under a grouped heading
    if (activeGroupCategory) {
      const entity = isValidEntity(line, activeGroupCategory);
      if (entity) valid.push(entity);
    }
  }

  if (valid.length > 0) return valid;

  // Case 4: JSON array fallback
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.text !== 'string' || typeof candidate.category !== 'string') continue;

      const entity = isValidEntity(candidate.text, candidate.category);
      if (entity) valid.push(entity);
    }
    return valid;
  } catch {
    return [];
  }
}

export async function runLocalContextualScan(
  stage1SanitizedText: string,
  vault: VaultMap
): Promise<LocalScanResult> {
  const startedAt = performance.now();
  const model = getLocalPiiModel();

  if (!model) {
    return {
      sanitizedText: stage1SanitizedText,
      addedRedactions: 0,
      engineStatus: 'on-device-unavailable',
      latencyMs: Math.round(performance.now() - startedAt),
      note: 'Firebase AI configured nahi hai. Fail-closed: raw text cloud par nahi bheja.',
    };
  }

  // FIX 3: Single-pass 2500-char cap taaki 2-chunk loop ki wajah se 80s latency na ho
  const scanText = stage1SanitizedText.slice(0, 2500);

  // FIX 4: Distinct few-shot example taaki unlabeled resume par bhi Nano exact format follow kare
  const prompt = [
    'Extract personal names, addresses/cities, company/school names, and currency amounts from TEXT.',
    'Output one entity per line as CATEGORY|EXACT_TEXT.',
    'Categories: PERSON, ADDRESS, ORG, FINANCIAL',
    'Example:',
    'PERSON|Priya Verma',
    'ADDRESS|Jaipur, India',
    'ORG|Nimbus Labs',
    'Rules: Copy exact text from TEXT. Skip [TOKEN_1] placeholders and section headings. Do not output None or notes.',
    '',
    'TEXT:',
    scanText,
  ].join('\n');

  try {
    const response = await model.generateContent(prompt);
    const rawOutput = response.response.text();
    // console.log use kiya hai taaki DevTools Default levels mein raw Nano output turant dikhe
    console.log('[Stage 2 Nano raw output]\n', rawOutput);
    const entities = parseEntities(rawOutput);

    if (entities.length === 0) {
      return {
        sanitizedText: stage1SanitizedText,
        addedRedactions: 0,
        engineStatus: 'on-device-success',
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }

    const sorted = [...entities].sort((a, b) => b.text.length - a.text.length);
    const entityMap = new Map<string, ContextualCategory>();
    const uniquePatterns: string[] = [];

    for (const entity of sorted) {
      const key = entity.text.toLowerCase();
      if (entityMap.has(key)) continue;
      entityMap.set(key, entity.category);

      const escaped = escapeRegExp(entity.text);
      const leftBoundary = /^\w/.test(entity.text) ? '\\b' : '';
      const rightBoundary = /\w$/.test(entity.text) ? '\\b' : '';
      uniquePatterns.push(`${leftBoundary}${escaped}${rightBoundary}`);
    }

    const combinedRegex = new RegExp(`(\\[[A-Z_]+_\\d+\\])|(${uniquePatterns.join('|')})`, 'gi');
    const beforeCount = vault.getRecords().length;

    const output = stage1SanitizedText.replace(
      combinedRegex,
      (match, existingToken: string | undefined) => {
        if (existingToken) return existingToken;
        const category = entityMap.get(match.toLowerCase());
        if (!category) return match;
        return vault.register(match, category, 'gemini-nano');
      }
    );

    return {
      sanitizedText: output,
      addedRedactions: vault.getRecords().length - beforeCount,
      engineStatus: 'on-device-success',
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'On-device model unavailable';
    const isUnavailable = /not available|unsupported|on-device|language model/i.test(message);

    return {
      sanitizedText: stage1SanitizedText,
      addedRedactions: 0,
      engineStatus: isUnavailable ? 'on-device-unavailable' : 'on-device-error',
      latencyMs: Math.round(performance.now() - startedAt),
      note: message,
    };
  }
}