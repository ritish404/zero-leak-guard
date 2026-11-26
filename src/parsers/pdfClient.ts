import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ParsedDocument {
  fileName: string;
  text: string;
  pageCount: number;
  sizeKb: number;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function extractDocumentText(file: File): Promise<ParsedDocument> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('File 10 MB se badi hai. Local browser processing ke liye chhoti file upload karein.');
  }

  const sizeKb = Math.max(1, Math.round(file.size / 1024));
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.txt') || lowerName.endsWith('.md') || file.type.startsWith('text/')) {
    const text = (await file.text()).trim();
    if (!text) throw new Error('Uploaded text file khali hai.');
    return { fileName: file.name, text, pageCount: 1, sizeKb };
  }

  if (!lowerName.endsWith('.pdf') && file.type !== 'application/pdf') {
    throw new Error('Sirf .pdf, .txt, ya .md files supported hain.');
  }

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  const pages: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // FIX: hasEOL preserve kiya taaki header/address/body alag lines par rahein (Nano accuracy ke liye critical)
    let pageText = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      pageText += item.str;
      pageText += 'hasEOL' in item && item.hasEOL ? '\n' : ' ';
    }

    const cleanedPage = pageText
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (cleanedPage) pages.push(cleanedPage);
  }

  const combinedText = pages.join('\n\n').trim();
  if (!combinedText) {
    throw new Error(
      'Is PDF mein selectable text nahi mila (scanned image PDF lag rahi hai). Text-based PDF try karein.'
    );
  }

  return {
    fileName: file.name,
    text: combinedText,
    pageCount: pdf.numPages,
    sizeKb,
  };
}