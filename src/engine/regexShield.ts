// FIX: `import type` use kiya hai kyunki VaultMap aur PiiCategory yahan sirf types hain
import type { VaultMap, PiiCategory } from './vaultMap';

// FIX: PolicyMode export karna zaroori hai taaki App.tsx ise import kar sake
export type PolicyMode = 'strict_india' | 'global_gdpr';

interface ShieldRule {
  category: PiiCategory;
  pattern: RegExp;
  indiaOnly?: boolean;
}

// Strict priority order: lambe/specific patterns pehle taaki phone regex Aadhaar/Card ko beech se na kaate
const SHIELD_RULES: ShieldRule[] = [
  {
    category: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    category: 'CARD',
    pattern: /(?<!\d)(?:\d{4}[-\s]?){3}\d{4}(?!\d)/g,
  },
  {
    category: 'AADHAAR',
    pattern: /(?<!\d)[2-9]\d{3}[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g,
    indiaOnly: true,
  },
  {
    category: 'PAN',
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    indiaOnly: true,
  },
  {
    category: 'IFSC',
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    indiaOnly: true,
  },
  {
    // Email pehle hi redact ho chuka hoga, isliye ab sirf UPI handles match honge
    category: 'UPI',
    pattern: /\b[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}\b/g,
    indiaOnly: true,
  },
  {
    category: 'PHONE',
    pattern: /(?<!\d)(?:(?:\+91|91)[-\s]?)?[6-9]\d{4}[-\s]?\d{5}(?!\d)/g,
  },
];

// Bank account number sirf label ke paas match hoga taaki random numbers par false positive na aaye
const BANK_ACC_PATTERN =
  /((?:account|a\/c|acc)\.?\s*(?:no\.?|number)?\s*[:#-]?\s*)(\d{9,18})\b/gi;

export interface RegexShieldResult {
  sanitizedText: string;
  redactionCount: number;
}

// FIX: runRegexShield export kiya gaya hai (Time complexity: O(R * N), R = rules, N = text length)
export function runRegexShield(
  rawText: string,
  vault: VaultMap,
  mode: PolicyMode = 'strict_india'
): RegexShieldResult {
  let output = rawText;

  for (const rule of SHIELD_RULES) {
    if (rule.indiaOnly && mode !== 'strict_india') continue;
    output = output.replace(rule.pattern, (match) =>
      vault.register(match, rule.category, 'regex')
    );
  }

  output = output.replace(
    BANK_ACC_PATTERN,
    (_full: string, prefix: string, accNum: string) => {
      const token = vault.register(accNum, 'BANK_ACC', 'regex');
      return `${prefix}${token}`;
    }
  );

  return {
    sanitizedText: output,
    redactionCount: vault.getRecords().length,
  };
}