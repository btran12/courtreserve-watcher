'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Append-only change log plus a mutable snapshot of every tracked session. */
class Store {
  constructor({ stateFile, historyFile, logFile, root = process.cwd() }) {
    this.stateFile = path.resolve(root, stateFile);
    this.historyFile = path.resolve(root, historyFile);
    this.logFile = logFile ? path.resolve(root, logFile) : null;
    this.state = this._loadState();
  }

  _loadState() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.events) {
        return { version: 1, events: parsed.events, lastRunAt: parsed.lastRunAt ?? null };
      }
    } catch {
      // Missing or corrupt state starts a fresh baseline; history.jsonl is untouched.
    }
    return { version: 1, events: {}, lastRunAt: null };
  }

  _writeAtomic(target, contents) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, target);
  }

  get events() {
    return this.state.events;
  }

  get(number) {
    return this.state.events[number] ?? null;
  }

  save(record) {
    const prev = this.state.events[record.number];
    this.state.events[record.number] = {
      ...record,
      firstSeenAt: prev?.firstSeenAt ?? record.scrapedAt,
      lastChangeAt: prev && rostersEqual(prev, record) ? prev.lastChangeAt : record.scrapedAt,
    };
  }

  /** Drops sessions that ended long ago so state.json does not grow forever. */
  prune({ keepDaysAfterStart = 14, now = Date.now() } = {}) {
    const cutoff = now - keepDaysAfterStart * 86400000;
    let removed = 0;
    for (const [number, ev] of Object.entries(this.state.events)) {
      const start = ev.startUtcMs ?? Date.parse(ev.startIso ?? 0);
      if (Number.isFinite(start) && start < cutoff) {
        delete this.state.events[number];
        removed++;
      }
    }
    return removed;
  }

  commit(lastRunAt = new Date().toISOString()) {
    this.state.lastRunAt = lastRunAt;
    this._writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  appendHistory(entries) {
    if (!entries.length) return;
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(this.historyFile, lines, 'utf8');
  }

  readHistory({ limit = 400 } = {}) {
    let raw = '';
    try {
      raw = fs.readFileSync(this.historyFile, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const out = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip a torn final line rather than failing the whole read.
      }
    }
    return out;
  }

  /** Always written to the log file; `echo` controls stdout for --quiet runs. */
  log(message, echo = true) {
    const line = `${new Date().toISOString()} ${message}\n`;
    if (echo) process.stdout.write(line);
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, line, 'utf8');
    } catch {
      // Logging must never take down a poll cycle.
    }
  }
}

function rostersEqual(a, b) {
  return (
    a.signed === b.signed &&
    a.max === b.max &&
    sameSet(a.registrants, b.registrants) &&
    sameSet(a.waitlist, b.waitlist)
  );
}

const sameSet = (x, y) =>
  (x?.length ?? 0) === (y?.length ?? 0) &&
  new Set((x ?? []).map((n) => n.toLowerCase())).size === new Set((y ?? []).map((n) => n.toLowerCase())).size &&
  (x ?? []).every((n) => (y ?? []).some((m) => m.toLowerCase() === n.toLowerCase()));

module.exports = { Store, rostersEqual, sameSet };
