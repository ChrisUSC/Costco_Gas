// --- Lazy-Loaded Price History & Chart.js Modal ---

import {
    parseScraperTimestamp,
    extractGradePrices,
    getValidPrice,
    GRADE_KEYS,
    GRADE_INFO
} from './utils.js';
import { state, setHistoryRangeDays } from './state.js';

let globalHistory = {};
let priceChartInstance = null;
let historyLoaded = false;
let historyLoadPromise = null;
let currentModalState = null;
let currentModalCity = null;

// Show a dot on every day (including unchanged ones) when the range has this many points or fewer.
const SHOW_ALL_DOTS_MAX_POINTS = 45;

export const HISTORY_RANGE_OPTIONS = [
    { label: '7D', days: 7 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
    { label: '1Y', days: 365 },
    { label: 'All', days: 0 }
];

export function ensureHistoryLoaded() {
    if (historyLoaded) return Promise.resolve();
    if (historyLoadPromise) return historyLoadPromise;

    const cacheBuster = state.latestTimestamp ? encodeURIComponent(state.latestTimestamp) : Date.now();
    historyLoadPromise = (async () => {
        const res = await fetch(`us_history.json?v=${cacheBuster}`);
        if (!res.ok) throw new Error(`Failed to fetch price history (${res.status})`);
        const priceData = await res.json();

        Object.keys(priceData).sort().forEach(ts => {
            const d = parseScraperTimestamp(ts) || new Date(ts.replace(/-/g, '/'));
            const dayStr = d.toLocaleDateString();

            for (const stateCode in priceData[ts]) {
                for (const cityName in priceData[ts][stateCode]) {
                    const key = `${stateCode}_${cityName}`;
                    if (!globalHistory[key]) globalHistory[key] = [];

                    const [rRaw, pRaw, dRaw] = extractGradePrices(priceData[ts][stateCode][cityName]);
                    globalHistory[key].push({
                        rawDate: d,
                        dayStr,
                        reg: getValidPrice(rRaw),
                        prem: getValidPrice(pRaw),
                        diesel: getValidPrice(dRaw)
                    });
                }
            }
        });

        historyLoaded = true;
    })().catch(err => {
        historyLoadPromise = null;
        throw err;
    });

    return historyLoadPromise;
}

function showChartMessage(msg, isError = false) {
    const chartContainer = document.querySelector('.chart-container');
    if (!chartContainer) return;
    const color = isError ? 'var(--costco-red)' : 'var(--text-muted)';
    chartContainer.innerHTML = `<p class="empty-msg" style="color:${color};">${msg}</p>`;
}

// Turn change-only entries into one point per day (last known price carried forward).
// `points` must be sorted ascending by rawDate. Days before the first known price are skipped.
function expandToDaily(points, start, end) {
    const out = [];
    let idx = 0;
    let last = null;
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());

    for (; d <= endDay; d.setDate(d.getDate() + 1)) {
        const nextDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        while (idx < points.length && points[idx].rawDate < nextDay) {
            last = points[idx++];
        }
        if (last) {
            out.push({
                rawDate: new Date(d),
                reg: last.reg,
                prem: last.prem,
                diesel: last.diesel
            });
        }
    }
    return out;
}

export function renderRangeControls() {
    let controls = document.getElementById('historyRangeControls');
    const chartContainer = document.querySelector('.chart-container');
    if (!chartContainer) return;

    if (!controls) {
        controls = document.createElement('div');
        controls.id = 'historyRangeControls';
        controls.className = 'history-range-controls';
        chartContainer.parentNode.insertBefore(controls, chartContainer);
    }

    controls.innerHTML = HISTORY_RANGE_OPTIONS.map(opt => {
        const activeClass = state.historyRangeDays === opt.days ? 'active' : '';
        return `<button type="button" class="history-range-btn ${activeClass}" data-action="set-history-range" data-days="${opt.days}">${opt.label}</button>`;
    }).join('');
}

export function setHistoryRange(days) {
    const numDays = parseInt(days, 10);
    setHistoryRangeDays(isNaN(numDays) ? 30 : numDays);
    renderRangeControls();
    if (currentModalState && currentModalCity) {
        renderPriceChart(currentModalState, currentModalCity);
    }
}

export async function openHistoryModal(stateCode, city) {
    currentModalState = stateCode;
    currentModalCity = city;

    const modal = document.getElementById('chartModal');
    const title = document.getElementById('chartTitle');
    if (modal) modal.classList.add('active');
    if (title) title.innerText = `Price History: ${city}, ${stateCode}`;

    renderRangeControls();

    if (!historyLoaded) {
        showChartMessage('Loading price history…');
        try {
            await ensureHistoryLoaded();
        } catch (e) {
            console.error('Error loading price history:', e);
            showChartMessage("Couldn't load price history. Please try again.", true);
            return;
        }
    }

    renderPriceChart(stateCode, city);
}

export function renderPriceChart(stateCode, city) {
    const key = `${stateCode}_${city}`;
    const chartContainer = document.querySelector('.chart-container');
    const history = globalHistory[key];

    if (!history || history.length === 0) {
        showChartMessage(`No price history available for ${city}, ${stateCode}.`);
        return;
    }

    if (!document.getElementById('priceChart')) {
        chartContainer.innerHTML = `<canvas id="priceChart"></canvas>`;
    }

    // Keep only the last entry per calendar day
    let dedupedHistory = [];
    const seenDates = new Set();
    for (let i = history.length - 1; i >= 0; i--) {
        if (!seenDates.has(history[i].dayStr)) {
            seenDates.add(history[i].dayStr);
            dedupedHistory.unshift(history[i]);
        }
    }

    const now = state.latestTimestamp ? (parseScraperTimestamp(state.latestTimestamp) || new Date()) : new Date();

    // Expand change-only entries into one point per day. Prices from before the
    // range start are carried forward automatically, and the series always
    // extends through today.
    const start = state.historyRangeDays > 0
        ? new Date(now.getTime() - state.historyRangeDays * 86400 * 1000)
        : dedupedHistory[0].rawDate;

    dedupedHistory = expandToDaily(dedupedHistory, start, now);

    if (dedupedHistory.length === 0) {
        showChartMessage(`No price history available for ${city}, ${stateCode} in this range.`);
        return;
    }

    const showAllDots = dedupedHistory.length <= SHOW_ALL_DOTS_MAX_POINTS;
    const surfaceColor = state.isDarkMode ? '#1e293b' : '#ffffff';

    const labels = dedupedHistory.map(h => h.rawDate);
    const datasets = GRADE_KEYS
        .map(g => {
            const info = GRADE_INFO[g];
            const data = dedupedHistory.map(h => h[info.histKey] === Infinity ? null : h[info.histKey]);
            // Filled dot = this grade's price changed that day (or first point).
            // Hollow dot = carried forward from an earlier day (short ranges only).
            const changed = data.map((v, i) => i === 0 || v !== data[i - 1]);
            return {
                grade: g,
                label: info.label,
                data,
                changed,
                borderColor: info.color,
                backgroundColor: info.color,
                stepped: 'after',
                pointBackgroundColor: changed.map(c => (c ? info.color : surfaceColor)),
                pointBorderColor: info.color,
                pointRadius: changed.map(c => (c ? 4 : showAllDots ? 2.5 : 0)),
                pointHoverRadius: 6,
                spanGaps: true
            };
        })
        .filter(ds => ds.grade !== 'diesel' || ds.data.some(v => v !== null));

    const textColor = state.isDarkMode ? '#f8fafc' : '#1e293b';
    const gridColor = state.isDarkMode ? '#334155' : '#e2e8f0';

    const ctx = document.getElementById('priceChart').getContext('2d');
    if (priceChartInstance) priceChartInstance.destroy();

    priceChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            // Hover anywhere along the x-axis to see every grade's price for that day
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: textColor } },
                tooltip: {
                    callbacks: {
                        label: context => {
                            if (context.raw === null || context.raw === undefined) return `${context.dataset.label}: n/a`;
                            return `${context.dataset.label}: $${context.raw.toFixed(2)}`;
                        },
                        afterLabel: context =>
                            context.dataset.changed[context.dataIndex] ? '  (price changed)' : ''
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        tooltipFormat: 'MMM d, yyyy',
                        displayFormats: { month: 'MMM yyyy' }
                    },
                    ticks: { color: textColor },
                    grid: { color: gridColor }
                },
                y: {
                    grace: '5%', // keeps flat lines from hugging the chart edges
                    ticks: { color: textColor, callback: value => `$${value.toFixed(2)}` },
                    grid: { color: gridColor }
                }
            }
        }
    });
}

export function isChartModalOpen() {
    return document.getElementById('chartModal')?.classList.contains('active') || false;
}

export function refreshChartTheme() {
    if (isChartModalOpen() && currentModalState && currentModalCity) {
        renderPriceChart(currentModalState, currentModalCity);
    }
}

export function closeHistoryModal(event) {
    if (event && event.target !== document.getElementById('chartModal') && !event.target.closest('.modal-close')) {
        return;
    }
    document.getElementById('chartModal')?.classList.remove('active');
}