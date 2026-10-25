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

    let dedupedHistory = [];
    const seenDates = new Set();
    for (let i = history.length - 1; i >= 0; i--) {
        if (!seenDates.has(history[i].dayStr)) {
            seenDates.add(history[i].dayStr);
            dedupedHistory.unshift(history[i]);
        }
    }

    const now = state.latestTimestamp ? (parseScraperTimestamp(state.latestTimestamp) || new Date()) : new Date();

    if (state.historyRangeDays > 0) {
        const cutoff = new Date(now.getTime() - state.historyRangeDays * 86400 * 1000);

        // Find the most recent price before or at cutoff to anchor the left edge of the range
        let baselineBeforeCutoff = null;
        for (let i = 0; i < dedupedHistory.length; i++) {
            if (dedupedHistory[i].rawDate <= cutoff) {
                baselineBeforeCutoff = dedupedHistory[i];
            } else {
                break;
            }
        }

        const inRange = dedupedHistory.filter(h => h.rawDate > cutoff && h.rawDate <= now);

        if (baselineBeforeCutoff) {
            dedupedHistory = [
                {
                    rawDate: cutoff,
                    dayStr: cutoff.toLocaleDateString(),
                    reg: baselineBeforeCutoff.reg,
                    prem: baselineBeforeCutoff.prem,
                    diesel: baselineBeforeCutoff.diesel
                },
                ...inRange
            ];
        } else if (inRange.length > 0) {
            dedupedHistory = inRange;
        } else {
            // All recorded history was before cutoff; anchor at cutoff with latest known price
            const last = dedupedHistory[dedupedHistory.length - 1];
            dedupedHistory = [
                {
                    rawDate: cutoff,
                    dayStr: cutoff.toLocaleDateString(),
                    reg: last.reg,
                    prem: last.prem,
                    diesel: last.diesel
                }
            ];
        }
    }

    // Always anchor the right edge to 'now' so the line extends across un-changed days to today
    if (dedupedHistory.length > 0) {
        const lastPoint = dedupedHistory[dedupedHistory.length - 1];
        if (lastPoint.rawDate.getTime() < now.getTime()) {
            dedupedHistory.push({
                rawDate: now,
                dayStr: now.toLocaleDateString(),
                reg: lastPoint.reg,
                prem: lastPoint.prem,
                diesel: lastPoint.diesel
            });
        }
    }

    if (dedupedHistory.length === 0) {
        showChartMessage(`No price history available for ${city}, ${stateCode} in this range.`);
        return;
    }

    const labels = dedupedHistory.map(h => h.rawDate);
    const datasets = GRADE_KEYS
        .map(g => {
            const info = GRADE_INFO[g];
            const data = dedupedHistory.map(h => h[info.histKey] === Infinity ? null : h[info.histKey]);
            return {
                grade: g,
                label: info.label,
                data,
                borderColor: info.color,
                backgroundColor: info.color,
                stepped: 'before',
                pointRadius: 3,
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
            plugins: {
                legend: { labels: { color: textColor } },
                tooltip: {
                    callbacks: {
                        label: context => `${context.dataset.label}: $${context.raw.toFixed(2)}`
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
