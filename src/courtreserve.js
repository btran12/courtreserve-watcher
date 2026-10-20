'use strict';

const APP_BASE = 'https://app.courtreserve.com';
const EVENTS_API_BASE = 'https://events.courtreserve.com';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const unescapeHtml = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/**
 * Reads the unauthenticated CourtReserve member portal for one organization.
 *
 * Both endpoints used here are internal to the portal (not the documented,
 * Basic-Auth-gated api.courtreserve.com API) and can change without notice.
 * Every request re-uses a single cookie jar because the event-detail page
 * hands out a short-lived signed `requestData` token tied to the session.
 */
class CourtReserveClient {
  constructor({ orgId, timezone = 'America/New_York', userAgent = DEFAULT_UA, delayMs = 700, retries = 2 } = {}) {
    if (!orgId) throw new Error('orgId is required');
    this.orgId = String(orgId);
    this.timezone = timezone;
    this.userAgent = userAgent;
    this.delayMs = delayMs;
    this.retries = retries;
    this.jar = new Map();
    this.primed = false;
  }

  get cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _absorb(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  _headers(extra = {}) {
    const h = {
      'User-Agent': this.userAgent,
      'Accept-Language': 'en-US,en;q=0.9',
      ...extra,
    };
    if (this.cookieHeader) h.Cookie = this.cookieHeader;
    return h;
  }

  async _request(url, options = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
      try {
        const res = await fetch(url, { ...options, headers: this._headers(options.headers) });
        this._absorb(res);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status} from ${url}`);
          if (attempt < this.retries) continue;
          throw lastErr;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt === this.retries) throw err;
      }
    }
    throw lastErr;
  }

  async _get(url, referer) {
    return this._request(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: 'manual',
    });
  }

  /** Loads the calendar shell once so the cookie jar holds the portal/CF cookies. */
  async prime() {
    if (this.primed) return;
    await this._get(`${APP_BASE}/Online/Calendar/Events/${this.orgId}/Day`);
    this.primed = true;
  }

  /**
   * @returns {Promise<Array<object>>} raw scheduler rows for one calendar month.
   */
  async readCalendar(year, month) {
    await this.prime();

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const criteria = {
      startDate: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
      end: new Date(Date.UTC(year, month - 1, daysInMonth, 23, 59, 59)).toISOString(),
      Date: new Date(Date.UTC(year, month - 1, 1)).toUTCString(),
      orgId: this.orgId,
      TimeZone: this.timezone,
      KendoStart: { Year: year, Month: month, Day: 1 },
      KendoEnd: { Year: year, Month: month, Day: daysInMonth },
      Categories: [],
      EventTagIds: [],
      EventSessionIds: [],
      CostTypeId: '',
      MemberId: '',
      FamilyId: '',
      FamilyMemberIds: '',
      ViewType: 'Month',
      MonthlySelectedDate: '',
      IsLeagueCalendar: 'False',
      IncludeLeagues: 'True',
      IncludeRoundRobins: 'False',
    };

    const res = await this._request(`${APP_BASE}/Online/Calendar/ReadCalendarEvents/${this.orgId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${APP_BASE}/Online/Calendar/Events/${this.orgId}/Month`,
      },
      body: new URLSearchParams({ jsonData: JSON.stringify(criteria) }).toString(),
    });

    const body = await res.json();
    if (!body || !Array.isArray(body.Data)) {
      throw new Error(`ReadCalendarEvents returned no Data array (HTTP ${res.status})`);
    }
    return body.Data;
  }

  /**
   * Fetches the public registrant + waitlist names for one event occurrence.
   * Requires two round trips: the detail page mints the signed token that
   * the ApiDetails call needs, and that token is not reusable across pages.
   *
   * @returns {Promise<{registrants: string[], waitlist: string[], registrantCount: number|null}|{error: string}>}
   */
  async registrants(number) {
    const pageUrl = `${APP_BASE}/Online/Events/Details/${this.orgId}/${number}`;
    const pageRes = await this._get(pageUrl);
    if (pageRes.status !== 200) return { error: `detail page HTTP ${pageRes.status}` };
    const page = await pageRes.text();

    const tokenMatch = page.match(
      new RegExp(`fixUrl\\('(https://events\\.courtreserve\\.com/Online/EventsApi/ApiDetails[^']*)'\\)`)
    );
    if (!tokenMatch) return { error: 'no ApiDetails token in detail page' };

    await sleep(this.delayMs);
    const apiRes = await this._get(unescapeHtml(tokenMatch[1]), pageUrl);
    if (apiRes.status !== 200) return { error: `ApiDetails HTTP ${apiRes.status}` };
    const html = await apiRes.text();

    const countMatch = html.match(/data-testid="registrants-tab">\s*REGISTRANTS\s*\((\d+)\)/i);

    await sleep(this.delayMs);
    return {
      registrants: namesInTbody(html, 'registrants-table-body'),
      waitlist: namesInTbody(html, 'waitlisted-table-body'),
      registrantCount: countMatch ? Number(countMatch[1]) : null,
    };
  }
}

const cleanText = (s) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();

/**
 * Pulls the person's name out of one `<tr>`.
 *
 * The registrants and waitlist tables are shaped differently, and only one of
 * them carries a test hook:
 *   registrants:  <th scope="row" data-testid="name">Ada Lovelace</th>
 *   waitlist:     <th scope="col">1</th><th scope="row">Long Nguyen</th>
 * so the fallbacks matter as much as the happy path. The ordinal column in the
 * waitlist uses scope="col" while the name uses scope="row", which is what
 * makes step 2 reliable.
 */
function nameFromRow(rowHtml) {
  const tagged = rowHtml.match(/data-testid="name"[\s\S]*?>([\s\S]*?)<\/th>/i);
  if (tagged) {
    const n = cleanText(tagged[1]);
    if (n) return n;
  }

  const isName = (t) => t && !/^\d+$/.test(t);

  const scopeRow = [...rowHtml.matchAll(/<th\b[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((m) => cleanText(m[1]))
    .filter(isName);
  if (scopeRow.length) return scopeRow[scopeRow.length - 1];

  const cells = [...rowHtml.matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => cleanText(m[2]))
    .filter(isName);
  return cells.length ? cells[cells.length - 1] : '';
}

function namesInTbody(html, testId) {
  const body = sliceTbody(html, testId);
  if (!body) return [];
  const names = [];
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const name = nameFromRow(row);
    if (name) names.push(name);
  }
  return names;
}

function sliceTbody(html, testId) {
  const start = html.indexOf(`data-testid="${testId}"`);
  if (start < 0) return '';
  const open = html.indexOf('>', start);
  if (open < 0) return '';
  const close = html.indexOf('</tbody>', open);
  return html.slice(open + 1, close < 0 ? undefined : close);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  CourtReserveClient,
  namesInTbody,
  nameFromRow,
  sliceTbody,
  unescapeHtml,
  APP_BASE,
  EVENTS_API_BASE,
};
