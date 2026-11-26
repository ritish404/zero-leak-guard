// FIX: Is file mein koi import nahi hoga kyunki yeh khud hi base module hai

export type PiiCategory =
  | 'EMAIL'
  | 'CARD'
  | 'AADHAAR'
  | 'PAN'
  | 'IFSC'
  | 'UPI'
  | 'PHONE'
  | 'BANK_ACC'
  | 'PERSON'
  | 'ADDRESS'
  | 'ORG'
  | 'FINANCIAL';

export interface RedactionRecord {
  token: string;
  category: PiiCategory;
  source: 'regex' | 'gemini-nano';
  maskedPreview: string;
}

export class VaultMap {
  private tokenToValue = new Map<string, string>();
  private valueToToken = new Map<string, string>();
  private counters = new Map<PiiCategory, number>();
  private records: RedactionRecord[] = [];

  register(rawValue: string, category: PiiCategory, source: 'regex' | 'gemini-nano'): string {
    const normalized = rawValue.trim();
    if (!normalized) return rawValue;

    // Duplicate value ko same token milega (O(1) lookup via Hash Map)
    const existingToken = this.valueToToken.get(normalized);
    if (existingToken) return existingToken;

    const nextCount = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, nextCount);

    const token = `[${category}_${nextCount}]`;
    this.tokenToValue.set(token, normalized);
    this.valueToToken.set(normalized, token);
    this.records.push({
      token,
      category,
      source,
      maskedPreview: this.maskValue(normalized),
    });

    return token;
  }

  rehydrate(sanitizedText: string): string {
    return sanitizedText.replace(/\[[A-Z_]+_\d+\]/g, (token) => {
      return this.tokenToValue.get(token) ?? token;
    });
  }

  getRecords(): RedactionRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.tokenToValue.clear();
    this.valueToToken.clear();
    this.counters.clear();
    this.records = [];
  }

  private maskValue(val: string): string {
    if (val.length <= 4) return '****';
    return `${val.slice(0, 2)}***${val.slice(-2)}`;
  }
}