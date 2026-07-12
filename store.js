// League store — persistent night-by-night results for a recurring group.
// A plain JSON file is plenty here: one Node process, a few writes per night.
// Set DATA_DIR to move it off the default ./data (e.g. onto a mounted volume).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'leagues.json');

const MAX_LEAGUES = 2000;
const MAX_NIGHTS = 200; // per league

class StoreError extends Error {}

let data = load();

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed.leagues === 'object') return parsed;
  } catch {
    /* first run or unreadable — start fresh */
  }
  return { leagues: {} };
}

// Writes are debounced and atomic (tmp + rename) so a crash mid-write can't
// corrupt the file.
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      console.error('league store: failed to save', err);
    }
  }, 250);
  if (saveTimer.unref) saveTimer.unref();
}

function makeLeagueCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // same confusion-free alphabet as game codes
  let code = '';
  for (let i = 0; i < 6; i++) code += letters[crypto.randomInt(letters.length)];
  return code;
}

function createLeague(name) {
  name = String(name || '').trim().slice(0, 40);
  if (!name) throw new StoreError('Give the league a name.');
  if (Object.keys(data.leagues).length >= MAX_LEAGUES) {
    throw new StoreError('The server has too many leagues right now.');
  }
  let code;
  do {
    code = makeLeagueCode();
  } while (data.leagues[code]);
  data.leagues[code] = { code, name, createdAt: Date.now(), nights: [] };
  persist();
  return data.leagues[code];
}

function getLeague(code) {
  return data.leagues[String(code || '').trim().toUpperCase()] || null;
}

// Save (or re-save) a night. Keyed by gameCode so the host can hit save again
// later in the evening and just update the same night.
function saveNight(code, night) {
  const league = getLeague(code);
  if (!league) throw new StoreError('League not found.');
  const idx = league.nights.findIndex((n) => n.gameCode === night.gameCode);
  if (idx >= 0) league.nights[idx] = night;
  else {
    if (league.nights.length >= MAX_NIGHTS) throw new StoreError('This league is full.');
    league.nights.push(night);
  }
  persist();
  return league;
}

// All-time leaderboard, aggregated by (lowercased) player name.
function summary(code) {
  const league = getLeague(code);
  if (!league) return null;
  const players = new Map();
  const currencies = new Set(league.nights.map((n) => n.currency || ''));
  // Money totals only make sense if every night used the same real currency.
  const moneyOk =
    league.nights.length > 0 &&
    currencies.size === 1 &&
    !currencies.has('') &&
    league.nights.every((n) => n.valueMinor > 0);

  for (const night of league.nights) {
    for (const r of night.results) {
      const key = r.name.toLowerCase();
      const p = players.get(key) || {
        name: r.name,
        nights: 0,
        netChips: 0,
        netMinor: 0,
        handsWon: 0,
        bestNight: null,
      };
      p.nights += 1;
      p.netChips += r.net;
      p.netMinor += r.net * (night.valueMinor || 0);
      p.handsWon += r.handsWon;
      if (p.bestNight == null || r.net > p.bestNight) p.bestNight = r.net;
      players.set(key, p);
    }
  }
  return {
    code: league.code,
    name: league.name,
    createdAt: league.createdAt,
    currency: moneyOk ? [...currencies][0] : '',
    moneyOk,
    players: [...players.values()].sort((a, b) => b.netChips - a.netChips),
    nights: league.nights
      .slice(-30)
      .reverse()
      .map((n) => ({
        savedAt: n.savedAt,
        gameCode: n.gameCode,
        currency: n.currency,
        valueMinor: n.valueMinor,
        biggestPot: n.biggestPot,
        results: n.results,
      })),
  };
}

module.exports = { StoreError, createLeague, getLeague, saveNight, summary };
