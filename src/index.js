'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { CourtReserveClient } = require('./courtreserve');
const { selectEvents, monthsToFetch } = require('./calendar');
const { diffEvent, isNotifiable } = require('./diff');
const { Store } = require('./store');
const { notifyChanges } = require('./notify');
const { buildDashboard } = require('./dashboard');
const { publish } = require('./publish');

const loadConfig = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  return {
    dryRun: flags.has('--dry-run'),
    dashboardOnly: flags.has('--dashboard-only'),
    backfill: flags.has('--backfill'),
    publish: flags.has('--publish'),
    verbose: flags.has('--verbose') || flags.has('-v'),
    quiet: flags.has('--quiet'),
  };
}

const detailUrl = (orgId, number) => `https://app.courtreserve.com/Online/Events/Details/${orgId}/${number}`;

/**
 * Decides whether a session needs a fresh roster scrape this run.
 *
 * Sessions starting soon are scraped every poll; sessions further out are
 * scraped on a slower cadence. Registrations cluster in the day before a
 * session, so this cuts request volume several-fold without losing much
 * timeliness on the changes that matter.
 */
function dueForScrape({ ev, stored, nowMs, intensiveWindowMs, sparseIntervalMs, backfill }) {
  if (!stored || backfill) return true;
  if (ev.startUtcMs - nowMs < intensiveWindowMs) return true;
  const last = Date.parse(stored.scrapedAt ?? '');
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= sparseIntervalMs;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const store = new Store({ ...config.paths, root: ROOT });
  const log = (...a) => store.log(a.join(' '), !args.quiet);
  const tz = config.org.timezone;

  if (args.dashboardOnly) {
    renderDashboard({ config, store, tz, log });
    log(`dashboard rebuilt -> ${config.paths.dashboardFile}`);
    if (args.publish) {
      publish({ root: ROOT, config, log, force: true, dryRun: args.dryRun });
    }
    return;
  }

  const client = new CourtReserveClient({
    orgId: config.org.id,
    timezone: tz,
    delayMs: config.poll.requestDelayMs,
  });

  const now = new Date();
  const months = monthsToFetch(now, tz, config.poll.lookAheadDays, config.poll.maxMonths);

  // ---- gather calendar rows ------------------------------------------
  let rows = [];
  for (const { year, month } of months) {
    try {
      const batch = await client.readCalendar(year, month);
      log(`calendar ${year}-${String(month).padStart(2, '0')}: ${batch.length} rows`);
      rows = rows.concat(batch);
    } catch (err) {
      log(`ERROR calendar ${year}-${month}: ${err.message}`);
    }
  }
  if (!rows.length) throw new Error('no calendar rows returned; the portal may have changed or blocked us');

  let matches = selectEvents(rows, { timezone: tz, match: config.match, now });
  log(`matched ${matches.length} session(s) for the watch rule`);

  const horizon = now.getTime() + config.poll.lookAheadDays * 86400000;
  matches = matches.filter((ev) =>
    args.backfill ? ev.startUtcMs < horizon : !ev.inPast && ev.startUtcMs < horizon
  );
  if (!config.poll.includePastEvents && !args.backfill) {
    log(`${matches.length} upcoming within ${config.poll.lookAheadDays} days`);
  }

  // ---- scrape rosters + diff -----------------------------------------
  const grouped = [];
  let scraped = 0;
  let failed = 0;
  let skipped = 0;
  const nowMs = now.getTime();
  const intensiveWindowMs = (config.poll.intensiveWindowHours ?? 24) * 3600000;
  const sparseIntervalMs = (config.poll.sparseIntervalMinutes ?? 180) * 60000;

  for (const ev of matches) {
    const prev = store.get(ev.number);
    const due = dueForScrape({
      ev, stored: prev, nowMs, intensiveWindowMs, sparseIntervalMs, backfill: args.backfill,
    });
    if (!due) {
      skipped++;
      continue;
    }

    const res = await client.registrants(ev.number);
    if (res.error) {
      failed++;
      log(`ERROR roster ${ev.number} (${ev.startLabel}): ${res.error}`);
      continue; // keep the previous snapshot rather than recording an empty roster
    }
    scraped++;

    const record = {
      ...ev,
      detailsUrl: detailUrl(config.org.id, ev.number),
      registrants: res.registrants,
      waitlist: res.waitlist,
      scrapedAt: new Date().toISOString(),
      signed: res.registrantCount ?? res.registrants.length,
      startUtcMs: ev.startUtcMs,
    };

    const changes = diffEvent(prev, record);
    store.save(record);

    if (changes.length) {
      for (const c of changes) {
        log(`  ${c.type.padEnd(13)} ${ev.startLabel}  ${ev.name}  ${c.summary}`);
      }
      grouped.push({ event: record, changes });
    } else if (args.verbose) {
      log(`  unchanged     ${ev.startLabel}  ${ev.name}  [${record.registrants.length}/${record.max ?? '?'}]`);
    }
  }

  // ---- persist --------------------------------------------------------
  const historyEntries = [];
  for (const { event, changes } of grouped) {
    for (const c of changes) {
      historyEntries.push({
        at: c.at,
        type: c.type,
        name: c.name ?? null,
        summary: c.summary,
        number: event.number,
        eventName: event.name,
        startLabel: event.startLabel,
        startIso: event.startIso,
        signed: event.registrants.length,
        max: event.max,
      });
    }
  }

  if (args.dryRun) {
    log(`[dry-run] would append ${historyEntries.length} history record(s)`);
  } else {
    const pruned = store.prune({ now: now.getTime() });
    if (pruned) log(`pruned ${pruned} stale session(s) from state`);
    store.appendHistory(historyEntries);
    store.commit(now.toISOString());
  }

  // ---- notify + render ------------------------------------------------
  const toastTypes = config.notify?.toastTypes;
  const notifiable = grouped.filter(({ changes }) => changes.some((c) => isNotifiable(c, toastTypes)));
  if (notifiable.length) {
    const { sent } = await notifyChanges({
      grouped: notifiable,
      config,
      timezone: tz,
      log,
      dryRun: args.dryRun,
    });
    log(`toasts sent: ${sent}`);
  }

  renderDashboard({ config, store, tz, log, generatedAt: now });

  publish({
    root: ROOT,
    config,
    log,
    historyEntries,
    force: args.publish,
    dryRun: args.dryRun,
  });

  log(
    `done: ${scraped} scraped, ${skipped} not due, ${failed} failed, ${historyEntries.length} change(s), ` +
      `${store.readHistory({ limit: 1e9 }).length} total logged`
  );
  if (failed && !scraped) throw new Error('every roster fetch failed');
}

function renderDashboard({ config, store, tz, generatedAt = new Date() }) {
  const all = Object.values(store.events);
  const nowMs = generatedAt.getTime();
  const upcoming = all.filter((e) => (e.startUtcMs ?? Date.parse(e.startIso)) >= nowMs)
                      .sort((a, b) => a.startUtcMs - b.startUtcMs);
  const past = all.filter((e) => (e.startUtcMs ?? Date.parse(e.startIso)) < nowMs)
                  .sort((a, b) => b.startUtcMs - a.startUtcMs);

  const history = store.readHistory({ limit: 400 }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const dayAgo = nowMs - 86400000;
  const recent = history.filter((h) => Date.parse(h.at) > dayAgo);

  const html = buildDashboard({
    config,
    upcoming,
    past,
    history,
    generatedAt: generatedAt.toISOString(),
    stats: {
      changes24h: recent.filter((h) => h.type !== 'baseline').length,
      joined24h: recent.filter((h) => h.type === 'joined' || h.type === 'promoted').length,
      left24h: recent.filter((h) => h.type === 'left' || h.type === 'demoted').length,
      totalLogged: all.length,
    },
  });

  const out = path.resolve(ROOT, config.paths.dashboardFile);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');
}

module.exports = { main, renderDashboard, loadConfig, dueForScrape };

if (require.main === module) {
  main().catch((err) => {
    console.error(`${new Date().toISOString()} FATAL ${err.message}`);
    if (process.env.WATCHER_DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
