// --- Gas station opening hours and open / closed status in the station's time zone ---

import { escapeHtml } from './dom.js';

export const GAS_DAYS_SUN_FIRST = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const GAS_DAYS_MON_FIRST = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const GAS_DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
export const GAS_CLOSING_SOON_MINUTES = 60;

export function gasTimeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

export function formatGasTime(t) {
    const [h, m] = t.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

export function getStoreLocalNow(tz, now = new Date()) {
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

export function getGasStatus(store, now = new Date()) {
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

export function groupGasHours(hours) {
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

export function gasStatusHtml(store) {
    const status = getGasStatus(store);
    if (!status) return '';
    const cls = status.isOpen ? (status.closingSoon ? 'closing-soon' : 'open') : 'closed';
    return `<div class="gas-status ${cls}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(status.text)}</div>`;
}

export function gasHoursDetailsHtml(store) {
    if (!store.gasHours) return '';
    const rows = groupGasHours(store.gasHours)
        .map(r => `<div class="gas-hours-row"><span>${escapeHtml(r.label)}</span><span>${escapeHtml(r.text)}</span></div>`)
        .join('');
    return `<details class="gas-hours"><summary>Gas hours</summary>${rows}</details>`;
}
