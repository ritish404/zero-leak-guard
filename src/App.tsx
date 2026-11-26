import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  ShieldCheck,
  Lock,
  Cpu,
  Cloud,
  RefreshCw,
  Eye,
  AlertTriangle,
  Sparkles,
  Upload,
  FileText,
  Loader2,
} from 'lucide-react';
import { VaultMap, type RedactionRecord } from './engine/vaultMap';
import { runRegexShield, type PolicyMode } from './engine/regexShield';
import { runLocalContextualScan, type LocalScanResult } from './engine/localScanner';
import {
  runCloudAnalysis,
  runHybridQuickVerdict,
  type AnalysisTask,
  type CloudAnalysisResult,
} from './engine/cloudAnalyzer';
import { fetchRemotePolicyMode, isFirebaseConfigured } from './firebase/config';
import { extractDocumentText, type ParsedDocument } from './parsers/pdfClient';

// Note: Local mock test ke liye aap apna synthetic ID text textarea mein add kar sakte hain
const SAMPLE_DOC = `EMPLOYMENT & COMPENSATION AGREEMENT
Employee: Rahul Sharma
Residential Address: 22B, Sector 18, Noida, Uttar Pradesh
Employer: Apex FinTech Solutions Pvt. Ltd.
Annual CTC: INR 18,50,000 (Bond penalty of INR 2,00,000 if leaving within 18 months)
PAN: ABCDE1234F | Aadhaar: [Aadhaar Redacted]
Phone: +91 98765 43210 | Email: rahul.sharma@example.com
UPI: rahul@okhdfcbank | Salary A/c No: 123456789012 (IFSC: HDFC0001234)
Clause 7: Employer may terminate with 7 days notice, while Employee PAN ABCDE1234F must serve 90 days notice.`;

type InspectorTab = 'rehydrated' | 'sent' | 'raw_cloud';
type PipelineStage = 'idle' | 'stage1' | 'stage2' | 'stage3' | 'done';

// Inline **bold** parser (XSS-safe JSX, no dangerouslySetInnerHTML)
function renderInlineBold(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

// Lightweight Markdown renderer taaki raw "### **" aur "* **" clean UI ban sake
function FormattedReport({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);

  return (
    <div className="space-y-2 font-sans text-sm leading-relaxed text-slate-200">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trim();
        if (!line) return <div key={idx} className="h-1" />;

        // Headings (### / ## / #)
        if (/^#{1,3}\s+/.test(line)) {
          const cleanHeading = line.replace(/^#{1,3}\s+/, '').replace(/^\*\*|\*\*$/g, '');
          return (
            <h3 key={idx} className="text-base font-bold text-emerald-300 pt-2">
              {cleanHeading}
            </h3>
          );
        }

        // Pure bold sub-heading line (e.g. **Financial Obligations & Penalties**)
        if (line.startsWith('**') && line.endsWith('**') && !line.slice(2, -2).includes('**')) {
          return (
            <h4 key={idx} className="text-sm font-semibold text-sky-300 pt-2">
              {line.slice(2, -2)}
            </h4>
          );
        }

        // Bullet points (* or -)
        if (/^[-*]\s+/.test(line)) {
          const bulletBody = line.replace(/^[-*]\s+/, '');
          return (
            <div key={idx} className="flex items-start gap-2 pl-2">
              <span className="text-emerald-400 mt-1">•</span>
              <span>{renderInlineBold(bulletBody)}</span>
            </div>
          );
        }

        return <p key={idx}>{renderInlineBold(line)}</p>;
      })}
    </div>
  );
}

export default function App() {
  const [rawText, setRawText] = useState(SAMPLE_DOC);
  const [policyMode, setPolicyMode] = useState<PolicyMode>('strict_india');
  const [task, setTask] = useState<AnalysisTask>('risk_audit');
  const [customQuestion, setCustomQuestion] = useState('');
  const [strictFailClosed, setStrictFailClosed] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  // FIX: Live stage tracking taaki active scan ke dauran cards "Idle" na dikhayein
  const [activeStage, setActiveStage] = useState<PipelineStage>('idle');
  const [stage2Result, setStage2Result] = useState<LocalScanResult | null>(null);
  const [cloudResult, setCloudResult] = useState<CloudAnalysisResult | null>(null);
  const [hybridVerdict, setHybridVerdict] = useState<CloudAnalysisResult | null>(null);
  const [vaultRecords, setVaultRecords] = useState<RedactionRecord[]>([]);
  const [sanitizedPreview, setSanitizedPreview] = useState('');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('rehydrated');

  // Client-side PDF/TXT upload state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [uploadedDoc, setUploadedDoc] = useState<ParsedDocument | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    void fetchRemotePolicyMode().then((mode) => setPolicyMode(mode));
  }, []);

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsingFile(true);
    setUploadError(null);

    try {
      const parsed = await extractDocumentText(file);
      setUploadedDoc(parsed);
      setRawText(parsed.text);
      // Purane run ka state reset karo taaki naye doc ka data mix na ho
      setStage2Result(null);
      setCloudResult(null);
      setHybridVerdict(null);
      setVaultRecords([]);
      setSanitizedPreview('');
      setActiveStage('idle');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'File parse nahi ho payi.');
    } finally {
      setIsParsingFile(false);
      e.target.value = '';
    }
  }

  async function handleRunPipeline() {
    if (!rawText.trim() || isRunning) return;

    setIsRunning(true);
    setActiveStage('stage1');
    setStage2Result(null);
    setCloudResult(null);
    setHybridVerdict(null);

    const vault = new VaultMap();

    try {
      // Stage 1: Deterministic Regex Shield (structured PII)
      const stage1 = runRegexShield(rawText, vault, policyMode);
      setSanitizedPreview(stage1.sanitizedText);
      setVaultRecords(vault.getRecords());

      // Stage 2: Strict On-Device Gemini Nano Scan (unstructured PII)
      setActiveStage('stage2');
      const stage2 = await runLocalContextualScan(stage1.sanitizedText, vault);
      setStage2Result(stage2);
      setSanitizedPreview(stage2.sanitizedText);
      setVaultRecords(vault.getRecords());

      // Strict Fail-Closed on hone par agar Gemini Nano unavailable ho toh cloud call rok do
      if (strictFailClosed && stage2.engineStatus !== 'on-device-success') {
        setCloudResult({
          sentPayload: '',
          rawCloudResponse: '',
          rehydratedResponse: '',
          inferencePath: 'cloud-gemini-3-flash-preview',
          latencyMs: 0,
          blockedByLeakGate: true,
          error:
            'Strict Fail-Closed active: On-device Gemini Nano unavailable, so cloud call was aborted.',
        });
        setActiveStage('done');
        return;
      }

      // Stage 3 & 4: Sanitized Cloud Reasoning + Hybrid Quick Verdict + Local Re-hydration
      setActiveStage('stage3');
      const [analysis, quickVerdict] = await Promise.all([
        runCloudAnalysis(stage2.sanitizedText, vault, task, customQuestion),
        runHybridQuickVerdict(stage2.sanitizedText, vault),
      ]);

      setCloudResult(analysis);
      setHybridVerdict(quickVerdict);
      setActiveStage('done');
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-8 h-8 text-emerald-400" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Zero-Leak Document &amp; Form Guard
              </h1>
              <p className="text-xs text-slate-400">
                Hybrid Privacy Pipeline: Regex → On-Device Gemini Nano → Cloud Gemini → Local Re-hydration
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`text-xs px-2.5 py-1 rounded-full border ${
                isFirebaseConfigured
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              }`}
            >
              {isFirebaseConfigured ? 'Firebase + App Check Ready' : 'Firebase Config Missing'}
            </span>

            <select
              value={policyMode}
              onChange={(e) => setPolicyMode(e.target.value as PolicyMode)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm"
            >
              <option value="strict_india">Strict India PII (DPDP)</option>
              <option value="global_gdpr">Global Standard (GDPR)</option>
            </select>
          </div>
        </header>

        {/* Input Section + Client-Side PDF Upload */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs uppercase tracking-wider text-slate-400">
              Raw Document (stays strictly in browser RAM)
            </label>

            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.txt,.md,application/pdf,text/plain"
                onChange={(e) => void handleFileUpload(e)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isParsingFile || isRunning}
                className="inline-flex items-center gap-1.5 text-xs bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 px-3 py-1.5 rounded-lg transition cursor-pointer disabled:opacity-50"
              >
                {isParsingFile ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                ) : (
                  <Upload className="w-3.5 h-3.5 text-emerald-400" />
                )}
                {isParsingFile ? 'Parsing PDF Locally...' : 'Upload PDF / TXT (Local RAM)'}
              </button>
            </div>
          </div>

          {uploadedDoc && (
            <div className="flex items-center gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-1.5">
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span>
                Loaded <strong>{uploadedDoc.fileName}</strong> ({uploadedDoc.pageCount}{' '}
                {uploadedDoc.pageCount === 1 ? 'page' : 'pages'}, {uploadedDoc.sizeKb} KB — parsed
                100% locally in browser)
              </span>
            </div>
          )}

          {uploadError && (
            <div className="flex items-center gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{uploadError}</span>
            </div>
          )}

          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={8}
            className="w-full bg-slate-900 border border-slate-700 rounded-xl p-4 font-mono text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
          />

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={task}
              onChange={(e) => setTask(e.target.value as AnalysisTask)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm"
            >
              <option value="risk_audit">Risk &amp; Compliance Audit</option>
              <option value="summary">Executive Summary</option>
              <option value="action_items">Action Items &amp; Deadlines</option>
            </select>

            <input
              type="text"
              value={customQuestion}
              onChange={(e) => setCustomQuestion(e.target.value)}
              placeholder="Optional custom question (e.g. Is the bond clause risky?)"
              className="flex-1 min-w-[240px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
            />

            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={strictFailClosed}
                onChange={(e) => setStrictFailClosed(e.target.checked)}
                className="accent-emerald-500"
              />
              Strict Fail-Closed (Block Cloud if Nano offline)
            </label>

            <button
              onClick={() => void handleRunPipeline()}
              disabled={isRunning || isParsingFile}
              className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold px-5 py-2 rounded-lg transition cursor-pointer"
            >
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
              {isRunning ? 'Running 4-Stage Shield...' : 'Run 4-Stage Guard'}
            </button>
          </div>
        </section>

        {/* Stage Status Strip (Live activeStage indicator) */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 flex items-center gap-3">
            <Lock className="w-5 h-5 text-emerald-400 shrink-0" />
            <div className="text-xs">
              <div className="font-semibold text-slate-200">Stage 1: Regex Shield</div>
              <div className="text-slate-400">
                {activeStage === 'stage1'
                  ? 'Redacting structured PII...'
                  : `${vaultRecords.filter((r) => r.source === 'regex').length} structured items vaulted`}
              </div>
            </div>
          </div>

          <div
            className={`bg-slate-900/80 border rounded-xl p-3 flex items-center gap-3 ${
              activeStage === 'stage2' ? 'border-sky-500/60' : 'border-slate-800'
            }`}
          >
            {activeStage === 'stage2' ? (
              <Loader2 className="w-5 h-5 text-sky-400 animate-spin shrink-0" />
            ) : (
              <Cpu className="w-5 h-5 text-sky-400 shrink-0" />
            )}
            <div className="text-xs">
              <div className="font-semibold text-slate-200">Stage 2: On-Device Gemini Nano</div>
              <div className="text-slate-400">
                {activeStage === 'stage2'
                  ? 'Scanning contextual PII locally...'
                  : !stage2Result
                  ? 'Idle'
                  : stage2Result.engineStatus === 'on-device-success'
                  ? `Active (${stage2Result.addedRedactions} contextual items, ${stage2Result.latencyMs}ms)`
                  : `Unavailable (${stage2Result.latencyMs}ms)`}
              </div>
            </div>
          </div>

          <div
            className={`bg-slate-900/80 border rounded-xl p-3 flex items-center gap-3 ${
              activeStage === 'stage3' ? 'border-violet-500/60' : 'border-slate-800'
            }`}
          >
            {activeStage === 'stage3' ? (
              <Loader2 className="w-5 h-5 text-violet-400 animate-spin shrink-0" />
            ) : (
              <Cloud className="w-5 h-5 text-violet-400 shrink-0" />
            )}
            <div className="text-xs">
              <div className="font-semibold text-slate-200">Stage 3 &amp; 4: Cloud + Re-hydration</div>
              <div className="text-slate-400">
                {activeStage === 'stage3'
                  ? 'Analyzing tokenized payload in cloud...'
                  : !cloudResult
                  ? 'Idle'
                  : cloudResult.error
                  ? 'Blocked / Error'
                  : `Completed (${cloudResult.latencyMs}ms)`}
              </div>
            </div>
          </div>
        </section>

        {/* Stage 2 Fallback Note */}
        {stage2Result && stage2Result.engineStatus !== 'on-device-success' && (
          <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-3 flex items-start gap-2.5 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
            <div>
              <strong>On-Device Gemini Nano unavailable in this browser:</strong>{' '}
              {stage2Result.note} — Stage 1 structured PII is still vaulted locally; enable Chrome
              Built-in AI flags to redact contextual names/addresses on-device.
            </div>
          </div>
        )}

        {/* Hybrid Quick Verdict */}
        {hybridVerdict && !hybridVerdict.error && (
          <div className="bg-violet-500/10 border border-violet-500/30 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-violet-300">
              <Sparkles className="w-4 h-4" />
              Hybrid Quick Verdict (PREFER_ON_DEVICE • {hybridVerdict.latencyMs}ms)
            </div>
            <FormattedReport content={hybridVerdict.rehydratedResponse} />
          </div>
        )}

        {/* Payload Inspector & Output */}
        {(sanitizedPreview || cloudResult) && (
          <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <Eye className="w-4 h-4 text-emerald-400" />
                Live Payload Inspector (Zero-Leak Proof)
              </div>

              <div className="flex gap-2 text-xs">
                <button
                  onClick={() => setInspectorTab('rehydrated')}
                  className={`px-3 py-1 rounded-md cursor-pointer ${
                    inspectorTab === 'rehydrated'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <RefreshCw className="w-3 h-3 inline mr-1" />
                  Final Re-hydrated Answer
                </button>
                <button
                  onClick={() => setInspectorTab('sent')}
                  className={`px-3 py-1 rounded-md cursor-pointer ${
                    inspectorTab === 'sent'
                      ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Exact Payload Sent to Cloud
                </button>
                <button
                  onClick={() => setInspectorTab('raw_cloud')}
                  className={`px-3 py-1 rounded-md cursor-pointer ${
                    inspectorTab === 'raw_cloud'
                      ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Raw Tokenized Cloud Reply
                </button>
              </div>
            </div>

            <div className="p-4 leading-relaxed">
              {cloudResult?.error && inspectorTab !== 'sent' ? (
                <div className="font-mono text-sm text-rose-300 whitespace-pre-wrap">
                  {cloudResult.error}
                </div>
              ) : inspectorTab === 'sent' ? (
                <div className="font-mono text-sm text-sky-200 whitespace-pre-wrap">
                  {cloudResult?.sentPayload || sanitizedPreview}
                </div>
              ) : inspectorTab === 'raw_cloud' ? (
                <div className="font-mono text-sm text-violet-200 whitespace-pre-wrap">
                  {cloudResult?.rawCloudResponse || 'Run pipeline to inspect raw cloud response.'}
                </div>
              ) : cloudResult?.rehydratedResponse ? (
                <FormattedReport content={cloudResult.rehydratedResponse} />
              ) : (
                <div className="font-mono text-sm text-slate-400">
                  {isRunning
                    ? 'Running hybrid privacy pipeline...'
                    : 'Run pipeline to see locally re-hydrated answer.'}
                </div>
              )}
            </div>
          </section>
        )}

        {/* In-Memory Vault */}
        {vaultRecords.length > 0 && (
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-300">
              In-Memory Vault ({vaultRecords.length} items redacted — cleared on refresh)
            </div>
            <div className="flex flex-wrap gap-2">
              {vaultRecords.map((rec) => (
                <span
                  key={rec.token}
                  className={`text-xs font-mono px-2.5 py-1 rounded-md border ${
                    rec.source === 'gemini-nano'
                      ? 'bg-sky-950/60 border-sky-700 text-sky-200'
                      : 'bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                >
                  {rec.token} → {rec.maskedPreview} ({rec.source})
                </span>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}