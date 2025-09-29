import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjsLib from 'pdfjs-dist';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const PDF_PATH = path.join(ROOT, 'DDHQ Quiz.pdf');
const OUT_DIR = path.join(ROOT, 'src', 'config');
const OUT_FILE = path.join(OUT_DIR, 'quiz.json');

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

function parseQuizFromText(text) {
  // Heuristic parser: assumes questions like "Q1. ..." or numeric, options like A) B) etc.
  const lines = normalizeNewlines(text).split('\n').map(l => l.trim()).filter(Boolean);

  const questions = [];
  let current = null;
  const questionStart = /^(Q\s*\d+\.|\d+\.|Question\s*\d+\:)/i;
  const optionStart = /^(A\)|B\)|C\)|D\)|E\)|F\)|A\.|B\.|C\.|D\.|E\.|F\)|\([A-F]\))/i;

  for (const line of lines) {
    if (questionStart.test(line)) {
      if (current) questions.push(current);
      current = { prompt: line.replace(questionStart, '').trim(), options: [] };
      continue;
    }
    if (current && optionStart.test(line)) {
      const match = line.match(/^(?:\(?([A-F])\)?[\)\.]\s*)(.*)$/i);
      if (match) {
        const key = match[1].toUpperCase();
        const label = match[2].trim();
        current.options.push({ key, label });
      } else {
        current.options.push({ key: '?', label: line });
      }
      continue;
    }
    if (current) {
      if (current.options.length === 0) {
        current.prompt = (current.prompt + ' ' + line).trim();
      } else {
        const last = current.options[current.options.length - 1];
        last.label = (last.label + ' ' + line).trim();
      }
    }
  }
  if (current) questions.push(current);

  return { questions };
}

async function main() {
  if (!fs.existsSync(PDF_PATH)) {
    console.error(`PDF not found at ${PDF_PATH}`);
    process.exit(1);
  }
  const raw = new Uint8Array(fs.readFileSync(PDF_PATH));
  const pdf = await pdfjsLib.getDocument({ data: raw }).promise;
  let fullText = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items.map(i => i.str);
    fullText += strings.join('\n') + '\n';
  }
  const parsed = parseQuizFromText(fullText);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
  console.log(`Wrote ${parsed.questions.length} questions to ${OUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


