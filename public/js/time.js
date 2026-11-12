// --- Scraper timestamps (Pacific time) and the "Updated … ago" wording ---

export const SCRAPER_TIMEZONE = 'America/Los_Angeles';

export function getTimeZoneOffsetMinutes(timeZone, utcGuess) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = {};
    dtf.formatToParts(utcGuess).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
    const hour = parts.hour === '24' ? '00' : parts.hour;
    const asIfUTC = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
    return (asIfUTC - utcGuess.getTime()) / 60000;
}

export function parseScraperTimestamp(timestampStr) {
    if (!timestampStr) return null;
    const str = String(timestampStr).trim();

    if (/([+-]\d{2}:?\d{2}|Z)$/i.test(str)) {
        const d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) {
        const fallback = new Date(str.replace(/-/g, '/'));
        return isNaN(fallback.getTime()) ? null : fallback;
    }

    const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
    const second = match[6] ? Number(match[6]) : 0;
    const guessUTC = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMinutes = getTimeZoneOffsetMinutes(SCRAPER_TIMEZONE, new Date(guessUTC));
    return new Date(guessUTC - offsetMinutes * 60000);
}

// How long ago a scraper timestamp was, or null if it can't be parsed.
function timestampAge(timestampStr) {
    const date = parseScraperTimestamp(timestampStr);
    if (!date) return null;
    const diffMs = Date.now() - date.getTime();
    return { date, minutes: Math.round(diffMs / 60000), hours: Math.round(diffMs / 3600000) };
}

export function getRelativeTimeLabel(timestampStr) {
    const age = timestampAge(timestampStr);
    if (!age) return 'the last update';

    const { hours } = age;
    if (hours < 1) return 'the last hour';
    if (hours < 36) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

// Prices are scraped hourly, so a snapshot this old means several runs in a row failed
// or never started. The header label turns amber and says the prices may be out of date.
export const PRICES_STALE_HOURS = 4;

export function formatLastUpdatedLabel(timestampStr) {
    const age = timestampAge(timestampStr);
    if (!age) return { text: 'Update time unknown', title: '', stale: false };

    const { date: d, minutes, hours } = age;
    const days = Math.round(hours / 24);

    let text;
    if (minutes < 1) text = 'Updated just now';
    else if (minutes < 60) text = `Updated ${minutes} min ago`;
    else if (hours < 36) text = `Updated ${hours} hr ago`;
    else text = `Updated ${days} day${days === 1 ? '' : 's'} ago`;

    let title = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const stale = minutes >= PRICES_STALE_HOURS * 60;
    if (stale) {
        text += ' · may be out of date';
        title = `Prices last updated ${title}. They normally update every hour, so they may be out of date.`;
    }
    return { text, title, stale };
}
