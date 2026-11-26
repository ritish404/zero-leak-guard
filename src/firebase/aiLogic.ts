import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  type GenerativeModel,
} from 'firebase/ai';
import { app } from './config';

// Gemini Developer API backend (Spark free tier compatible)
export const ai = app ? getAI(app, { backend: new GoogleAIBackend() }) : null;

// Stage 2: Strictly on-device — raw document kabhi browser RAM se bahar nahi jayega
export function getLocalPiiModel(): GenerativeModel | null {
  if (!ai) return null;

  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
  });
}

// Stage 3: Cloud-only reasoning model (sirf sanitized/tokenized text ke liye)
export function getCloudAnalysisModel(): GenerativeModel | null {
  if (!ai) return null;

  return getGenerativeModel(ai, {
    // FIX: App Check authenticated probe mein sirf 'gemini-3-flash-preview' ne 200 WORKING diya
    model: 'gemini-3-flash-preview',
    // Bracketed tokens intact rakhna zaroori hai taaki Stage 4 local re-hydration fail na ho
    systemInstruction:
      'You analyze privacy-sanitized documents. Tokens like [PERSON_1], [PAN_1], [AADHAAR_1], [ORG_1], [ADDRESS_1] represent redacted entities. NEVER rename, alter, or remove these bracketed tokens in your response so the client can safely re-hydrate them locally.',
  });
}

// Post-sanitization helper: pehle on-device try karega, offline hone par sanitized text cloud par bhejega
export function getHybridSummaryModel(): GenerativeModel | null {
  if (!ai) return null;

  return getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      // FIX: Fallback cloud model bhi verified active model ID par set kiya
      model: 'gemini-3-flash-preview',
    },
  });
}