import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const QUIZ_PATH = path.join(ROOT, 'src', 'config', 'quiz.json');
const CHAR_PATH = path.join(ROOT, 'src', 'config', 'characters.json');
const RESULTS_PATH = path.join(ROOT, 'src', 'config', 'results.json');

export function loadQuiz() {
  if (!fs.existsSync(QUIZ_PATH)) throw new Error('src/config/quiz.json not found. Run npm run extract:quiz or create manually.');
  return JSON.parse(fs.readFileSync(QUIZ_PATH, 'utf-8'));
}

export function loadCharacters() {
  if (!fs.existsSync(CHAR_PATH)) throw new Error('src/config/characters.json not found.');
  return JSON.parse(fs.readFileSync(CHAR_PATH, 'utf-8')).characters;
}

export function loadResults() {
  if (!fs.existsSync(RESULTS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

// Map option keys (A-F) to character ids. Adjust after PDF parsing/validation.
export function getOptionKeyToCharacterIdMap() {
  // PDF results mapping:
  // Mostly A's: Eric Da Dawg
  // Mostly B's: Bullet Da Bulldawg
  // Mostly C's: Ellie Da Dawggette
  // Mostly D's: Raven Da Hellcat
  // Mostly E's: Bobcat Da Hellcat
  // Mostly F's: Luna Da Hellcat
  return {
    A: 'eric_da_dawg',
    B: 'bullet_da_bulldawg',
    C: 'ellie_da_dawggette',
    D: 'raven_da_hellcat',
    E: 'bobcat_da_hellcat',
    F: 'luna_da_hellcat'
  };
}

export function scoreAnswers(answers) {
  const optionToChar = getOptionKeyToCharacterIdMap();
  const tally = {};
  for (const a of answers) {
    const charId = optionToChar[a.option_key];
    if (!charId) continue;
    tally[charId] = (tally[charId] || 0) + 1;
  }
  let topId = null;
  let topScore = -1;
  for (const [charId, score] of Object.entries(tally)) {
    if (score > topScore) {
      topScore = score;
      topId = charId;
    }
  }
  return { topCharacterId: topId, tally };
}


