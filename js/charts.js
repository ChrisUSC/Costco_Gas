// --- Lazy-Loaded Price History & Chart.js Modal ---

let globalHistory = {};
let priceChartInstance = null;
let historyLoaded = false;
let historyLoadPromise = null;
let historyRangeDays = parseInt(localStorage.getItem('historyRangeDays'), 10);
if (isNaN(historyRangeDays)) historyRangeDays = 30;
let currentModalState = null;
let currentModalCity = null;

const HISTORY_RANGE_OPTIONS = [
    { label: '7D', days: 7 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
    { label: '1Y', days: 365 },
    { label: 'All', days: 0 }
];

function ensureHistoryLoaded() {
    if (historyLoaded) return Promise.resolve();
    if (historyLoadPromise) return historyLoadPromise;

    historyLoadPromise = (async () => {
        const res = await fetch(`us_history.json?t=${Date.now()}`);
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

function renderRangeControls() {
    let controls = document.getElementById('historyRangeControls');
    const chartContainer = document.querySelector('.chart-container');

    if (!controls) {
        controls = document.createElement('div');
        controls.id = 'historyRangeControls';
        controls.className = 'history-range-controls';
        chartContainer.parentNode.insertBefore(controls, chartContainer);
    }

    controls.innerHTML = HISTORY_RANGE_OPTIONS.map(opt => {
        const activeClass = historyRangeDays === opt.days ? 'active' : '';
        return `<button type="button" class="history-range-btn ${activeClass}" onclick="setHistoryRange(${opt.days})">${opt.label}</button>`;
    }).join('');
}

function setHistoryRange(days) {
    historyRangeDays = days;
    localStorage.setItem('historyRangeDays', days);
    renderRangeControls();
    if (currentModalState && currentModalCity) {
        renderPriceChart(currentModalState, currentModalCity);
    }
}

async function openHistoryModal(state, city) {
    currentModalState = state;
    currentModalCity = city;

    document.getElementById('chartModal').classList.add('active');
    document.getElementById('chartTitle').innerText = `Price History: ${city}, ${state}`;
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

    renderPriceChart(state, city);
}

function renderPriceChart(state, city) {
    const key = `${state}_${city}`;
    const chartContainer = document.querySelector('.chart-container');
    const history = globalHistory[key];

    if (!history || history.length === 0) {
        showChartMessage(`No price history available for ${city}, ${state}.`);
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

    if (historyRangeDays > 0) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - historyRangeDays);
        dedupedHistory = dedupedHistory.filter(h => h.rawDate >= cutoff);
    }

    if (dedupedHistory.length === 0) {
        showChartMessage(`No price history available for ${city}, ${state} in this range.`);
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
                tension: 0.1,
                pointRadius: 4,
                spanGaps: true
            };
        })
        .filter(ds => ds.grade !== 'diesel' || ds.data.some(v => v !== null));

    const textColor = isDarkMode ? '#f8fafc' : '#1e293b';
    const gridColor = isDarkMode ? '#334155' : '#e2e8f0';

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

function closeHistoryModal(event) {
    if (event && event.target !== document.getElementById('chartModal')) return;
    document.getElementById('chartModal').classList.remove('active');
}
