import type { VaultMap } from './vaultMap';
import { getCloudAnalysisModel, getHybridSummaryModel } from '../firebase/aiLogic';

export type AnalysisTask = 'risk_audit' | 'summary' | 'action_items';

export interface CloudAnalysisResult {
  sentPayload: string;
  rawCloudResponse: string;
  rehydratedResponse: string;
  inferencePath: 'cloud-gemini-3-flash-preview' | 'hybrid-prefer-on-device';
  latencyMs: number;
  blockedByLeakGate: boolean;
  error?: string;
}

// Pre-flight Leak Gate: cloud call se pehle final safety assertion
const LEAK_ASSERTION_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'EMAIL', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { label: 'PAN', regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/ },
  { label: 'AADHAAR', regex: /(?<!\d)[2-9]\d{3}[-\s]?\d{4}[-\s]?\d{4}(?!\d)/ },
  { label: 'CARD', regex: /(?<!\d)(?:\d{4}[-\s]?){3}\d{4}(?!\d)/ },
];

function detectUnredactedLeak(text: string): string | null {
  for (const check of LEAK_ASSERTION_PATTERNS) {
    if (check.regex.test(text)) return check.label;
  }
  return null;
}

function buildTaskPrompt(
  sanitizedText: string,
  task: AnalysisTask,
  customQuestion?: string
): string {
  const instructions: Record<AnalysisTask, string> = {
    risk_audit:
      'Perform a concise risk and compliance audit of this sanitized document. Highlight hidden clauses, financial obligations, and missing safeguards in bullet points.',
    summary:
      'Summarize this sanitized document in 5 crisp bullet points covering parties, key terms, and obligations.',
    action_items:
      'Extract concrete action items, deadlines, and verification steps required from this sanitized document.',
  };

  const focus = customQuestion?.trim()
    ? `Answer this specific user question using ONLY the document: "${customQuestion.trim()}"`
    : instructions[task];

  return [
    focus,
    'STRICT RULE: Preserve all bracketed tokens like [PERSON_1], [PAN_1], [AADHAAR_1], [ORG_1], [BANK_ACC_1] verbatim so local re-hydration works.',
    '',
    'SANITIZED DOCUMENT:',
    sanitizedText,
  ].join('\n');
}

export async function runCloudAnalysis(
  sanitizedText: string,
  vault: VaultMap,
  task: AnalysisTask = 'risk_audit',
  customQuestion?: string
): Promise<CloudAnalysisResult> {
  const startedAt = performance.now();

  // Hard block: agar koi raw structured PII bacha hai toh cloud call abort karo
  const leakedCategory = detectUnredactedLeak(sanitizedText);
  if (leakedCategory) {
    return {
      sentPayload: '',
      rawCloudResponse: '',
      rehydratedResponse: '',
      inferencePath: 'cloud-gemini-3-flash-preview',
      latencyMs: Math.round(performance.now() - startedAt),
      blockedByLeakGate: true,
      error: `Cloud call blocked: unredacted ${leakedCategory} detected in payload.`,
    };
  }

  const model = getCloudAnalysisModel();
  if (!model) {
    return {
      sentPayload: sanitizedText,
      rawCloudResponse: '',
      rehydratedResponse: '',
      inferencePath: 'cloud-gemini-3-flash-preview',
      latencyMs: Math.round(performance.now() - startedAt),
      blockedByLeakGate: false,
      error: 'Firebase AI Logic configured nahi hai (.env.local check karo).',
    };
  }

  const prompt = buildTaskPrompt(sanitizedText, task, customQuestion);

  try {
    const response = await model.generateContent(prompt);
    const rawCloudResponse = response.response.text();

    // Stage 4: Local RAM re-hydration (O(M) single regex pass via VaultMap Hash Map)
    const rehydratedResponse = vault.rehydrate(rawCloudResponse);

    return {
      sentPayload: sanitizedText,
      rawCloudResponse,
      rehydratedResponse,
      inferencePath: 'cloud-gemini-3-flash-preview',
      latencyMs: Math.round(performance.now() - startedAt),
      blockedByLeakGate: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Cloud inference failed';
    return {
      sentPayload: sanitizedText,
      rawCloudResponse: '',
      rehydratedResponse: '',
      inferencePath: 'cloud-gemini-3-flash-preview',
      latencyMs: Math.round(performance.now() - startedAt),
      blockedByLeakGate: false,
      error: message,
    };
  }
}

// Hybrid mode (PREFER_ON_DEVICE): sirf already-sanitized text ke liye 1-line quick verdict
export async function runHybridQuickVerdict(
  sanitizedText: string,
  vault: VaultMap
): Promise<CloudAnalysisResult> {
  const startedAt = performance.now();

  const leakedCategory = detectUnredactedLeak(sanitizedText);
  if (leakedCategory) {
    return {
      sentPayload: '',
      rawCloudResponse: '',
      rehydratedResponse: '',
      inferencePath: 'hybrid-prefer-on-device',
      latencyMs: Math.round(performance.now() - startedAt),
      blockedByLeakGate: true,
      error: `Hybrid call blocked: unredacted ${leakedCategory} detected.`,
    };
  }

  const model = getHybridSummaryModel();
  if (!model) {
    return {
      sentPayload: sanitizedText,
      rawCloudResponse: '',
      rehydratedResponse: '',
      inferencePath: 'hybrid-prefer-on-device',
      latencyMs: Math.round(performance.now() - startedAt),
      blockedByLeakGate: false,
      error: 'Firebase AI Logic configured nahi hai.',
    };
  }

  try {
    const response = await model.generateContent(
      `Give a 2-sentence executive risk verdict for this sanitized document. Keep all [TOKEN_N] placeholders unchanged.\n\n${sanitizedText}`
    );
    const rawCloudResponse = response.response.text();

    return {
      sentPayload: sanitizedText,
      rawCloudResponse,
      rehydratedResponse: vault.rehydrate(rawCloudResponse),
      inferencePath: 'hybrid-prefer-on-device',
      latencyMs: Math.round(performance.now() - startedAt),
      blockedByLeakGate: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Hybrid inference failed';
    return {
      sentPayload: sanitizedText,
      rawCloudResponse: '',
      rehydratedResponse: '',
      inferencePath: 'hybrid-prefer-on-device',
      latencyMs: Math.round(performance.now() - startedAt),
      blockedByLeakGate: false,
      error: message,
    };
  }
}