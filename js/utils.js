// --- Shared Constants, Grade Helpers, Geometry, Gas Hours & UI Utilities ---

const SCRAPER_TIMEZONE = 'America/Los_Angeles';
const CARTO_API_KEY = 'cb1_2q9b_1_6d41dfc2a130168400103206';

const GRADE_INFO = {
    regular: { label: 'Regular', color: '#059669', valKey: 'regVal', prevKey: 'prevRegVal', strKey: 'regularStr', histKey: 'reg' },
    premium: { label: 'Premium', color: '#E31837', valKey: 'premVal', prevKey: 'prevPremVal', strKey: 'premiumStr', histKey: 'prem' },
    diesel:  { label: 'Diesel',  color: '#7c3aed', valKey: 'dieselVal', prevKey: 'prevDieselVal', strKey: 'dieselStr', histKey: 'diesel' }
};
const GRADE_KEYS = Object.keys(GRADE_INFO);

function loadJsonPref(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

function gradeVal(store, grade) {
    return store[GRADE_INFO[grade].valKey];
}

function gradePrevVal(store, grade) {
    return store[GRADE_INFO[grade].prevKey];
}

function gradeStr(store, grade) {
    return store[GRADE_INFO[grade].strKey];
}

function hasGradeData(store, grade) {
    const v = gradeVal(store, grade);
    return v !== undefined && v !== Infinity && !isNaN(v);
}

// Only filter out stores missing the active grade when viewing Diesel
// (since only a minority of Costco warehouses sell diesel).
function shouldFilterStoresByGrade(grade) {
    return grade === 'diesel';
}

function filterStoresForCurrentGrade(dataArray) {
    if (!shouldFilterStoresByGrade(gasPref)) return dataArray;
    return dataArray.filter(store => hasGradeData(store, gasPref));
}

function getVisibleStoreGrades(store) {
    return GRADE_KEYS.filter(g => g !== 'diesel' || hasGradeData(store, 'diesel'));
}

const getValidPrice = (val) => {
    if (val === null || val === undefined || val === "N/A") return Infinity;
    if (typeof val === 'string') return parseFloat(val.replace('$', '').trim());
    return parseFloat(val);
};

const formatPriceDisplay = (val) => {
    if (val === null || val === undefined || val === Infinity || isNaN(val)) return "N/A";
    return `$${val.toFixed(2)}`;
};

function extractGradePrices(pData) {
    if (!pData) return [undefined, undefined, undefined];
    if (Array.isArray(pData)) {
        return [pData[0], pData[1], pData[2]];
    }
    return [
        pData.Regular ?? pData.regular,
        pData.Premium ?? pData.premium,
        pData.Diesel ?? pData.diesel
    ];
}

// --- Distance & Route Geometry Helpers ---

function getDistanceMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function distanceToSegmentMiles(lat, lng, lat1, lng1, lat2, lng2) {
    const toRad = d => d * Math.PI / 180;
    const cosMid = Math.cos(toRad((lat1 + lat2) / 2)) || 0.000001;
    const x = (lng - lng1) * cosMid;
    const y = lat - lat1;
    const dx = (lng2 - lng1) * cosMid;
    const dy = lat2 - lat1;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (x * dx + y * dy) / lenSq));
    return getDistanceMiles(lat, lng, lat1 + t * dy, lng1 + (t * dx) / cosMid);
}

function minDistanceToRouteMiles(lat, lng, routeCoords) {
    if (routeCoords.length === 1) {
        return getDistanceMiles(lat, lng, routeCoords[0][0], routeCoords[0][1]);
    }
    let min = Infinity;
    for (let i = 0; i < routeCoords.length - 1; i++) {
        const [lat1, lng1] = routeCoords[i];
        const [lat2, lng2] = routeCoords[i + 1];
        const d = distanceToSegmentMiles(lat, lng, lat1, lng1, lat2, lng2);
        if (d < min) min = d;
    }
    return min;
}

function getRouteBoundsPadded(routeCoords, bufferMiles) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [lat, lng] of routeCoords) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
    }
    const midLat = (minLat + maxLat) / 2;
    const padLat = bufferMiles / 69;
    const padLng = bufferMiles / (69 * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
    return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLng: minLng - padLng, maxLng: maxLng + padLng };
}

// --- Gas Station Hours ---

const GAS_DAYS_SUN_FIRST = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const GAS_DAYS_MON_FIRST = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const GAS_DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const GAS_CLOSING_SOON_MINUTES = 60;

function gasTimeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function formatGasTime(t) {
    const [h, m] = t.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

function getStoreLocalNow(tz, now = new Date()) {
    if (!tz) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(now);
        const get = type => parts.find(p => p.type === type)?.value;
        return {
            day: get('weekday').toLowerCase().slice(0, 3),
            minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10)
        };
    } catch (e) {
        return null;
    }
}

function getGasStatus(store, now = new Date()) {
    const hours = store.gasHours;
    const local = getStoreLocalNow(store.tz, now);
    if (!hours || !local) return null;

    const dayIdx = GAS_DAYS_SUN_FIRST.indexOf(local.day);
    if (dayIdx === -1) return null;
    const mins = local.minutes;
    const today = hours[GAS_DAYS_SUN_FIRST[dayIdx]];
    const yesterday = hours[GAS_DAYS_SUN_FIRST[(dayIdx + 6) % 7]];

    const openResult = (closeMins, closeLabel) => {
        const closingSoon = closeMins - mins <= GAS_CLOSING_SOON_MINUTES && closeMins - mins > 0;
        return {
            isOpen: true, closingSoon,
            text: closingSoon ? `Closing soon · ${closeLabel}` : `Open · closes ${closeLabel}`
        };
    };

    if (yesterday) {
        const yo = gasTimeToMinutes(yesterday[0]), yc = gasTimeToMinutes(yesterday[1]);
        if (yc < yo && mins < yc) return openResult(yc, formatGasTime(yesterday[1]));
    }

    if (today) {
        const o = gasTimeToMinutes(today[0]), c = gasTimeToMinutes(today[1]);
        if (o === c) return { isOpen: true, closingSoon: false, text: 'Open 24 hours' };
        if (c > o && mins >= o && mins < c) return openResult(c, formatGasTime(today[1]));
        if (c < o && mins >= o) return { isOpen: true, closingSoon: false, text: `Open · closes ${formatGasTime(today[1])} tomorrow` };
        if (mins < o) return { isOpen: false, closingSoon: false, text: `Closed · opens ${formatGasTime(today[0])}` };
    }

    for (let i = 1; i <= 7; i++) {
        const next = hours[GAS_DAYS_SUN_FIRST[(dayIdx + i) % 7]];
        if (next) {
            const when = i === 1 ? 'tomorrow' : GAS_DAY_LABELS[GAS_DAYS_SUN_FIRST[(dayIdx + i) % 7]];
            return { isOpen: false, closingSoon: false, text: `Closed · opens ${when} ${formatGasTime(next[0])}` };
        }
    }
    return { isOpen: false, closingSoon: false, text: 'Closed' };
}

function groupGasHours(hours) {
    const fmt = h => h ? `${formatGasTime(h[0])} – ${formatGasTime(h[1])}` : 'Closed';
    const rows = [];
    for (const day of GAS_DAYS_MON_FIRST) {
        const text = fmt(hours[day]);
        const last = rows[rows.length - 1];
        if (last && last.text === text) last.end = day;
        else rows.push({ start: day, end: day, text });
    }
    return rows.map(r => ({
        label: r.start === r.end ? GAS_DAY_LABELS[r.start] : `${GAS_DAY_LABELS[r.start]}–${GAS_DAY_LABELS[r.end]}`,
        text: r.text
    }));
}

function gasStatusHtml(store) {
    const status = getGasStatus(store);
    if (!status) return '';
    const cls = status.isOpen ? (status.closingSoon ? 'closing-soon' : 'open') : 'closed';
    return `<div class="gas-status ${cls}">● ${status.text}</div>`;
}

function gasHoursDetailsHtml(store) {
    if (!store.gasHours) return '';
    const rows = groupGasHours(store.gasHours)
        .map(r => `<div class="gas-hours-row"><span>${r.label}</span><span>${r.text}</span></div>`)
        .join('');
    return `<details class="gas-hours"><summary>Gas hours</summary>${rows}</details>`;
}

// --- Timestamps & Formatting ---

function getTimeZoneOffsetMinutes(timeZone, utcGuess) {
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

function parseScraperTimestamp(timestampStr) {
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

function getRelativeTimeLabel(timestampStr) {
    const d = parseScraperTimestamp(timestampStr);
    if (!d) return 'the last update';

    const hours = Math.round((Date.now() - d.getTime()) / 3600000);
    if (hours < 1) return 'the last hour';
    if (hours < 36) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

function formatLastUpdatedLabel(timestampStr) {
    const d = parseScraperTimestamp(timestampStr);
    if (!d) return { text: 'Last Updated: unknown', title: '' };

    const diffMs = Date.now() - d.getTime();
    const minutes = Math.round(diffMs / 60000);
    const hours = Math.round(diffMs / 3600000);
    const days = Math.round(hours / 24);

    let text;
    if (minutes < 1) text = 'Last Updated: just now';
    else if (minutes < 60) text = `Last Updated: ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    else if (hours < 36) text = `Last Updated: ${hours} hour${hours === 1 ? '' : 's'} ago`;
    else text = `Last Updated: ${days} day${days === 1 ? '' : 's'} ago`;

    const title = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return { text, title };
}

function getTrendArrow(current, previous) {
    if (current === undefined || current === Infinity || isNaN(current)) return '';
    if (previous === undefined || previous === null || previous === Infinity || isNaN(previous)) return '';

    const diff = current - previous;
    if (isNaN(diff)) return '';

    if (Math.abs(diff) < 0.005) {
        return `<span class="trend-flat" title="No change since ${trendBaselineLabel}">–</span>`;
    }
    if (diff > 0) {
        return `<span class="trend-up" title="Up $${diff.toFixed(2)} since ${trendBaselineLabel}">▲</span>`;
    }
    return `<span class="trend-down" title="Down $${Math.abs(diff).toFixed(2)} since ${trendBaselineLabel}">▼</span>`;
}

function getMedal(index) {
    if (index === 0) return '🥇';
    if (index === 1) return '🥈';
    if (index === 2) return '🥉';
    return `<span style="font-size:13px; color:var(--text-muted); margin-right:4px;">#${index + 1}</span>`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function showToast(message) {
    const existing = document.querySelector('.app-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'app-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 2200);
}

function requestBrowserLocation(onSuccess) {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        onSuccess,
        () => alert("Unable to retrieve your location. Check browser permissions.")
    );
}
