    let map;
    let mapTileLayer;
    let markersLayer;
    let globalStoreData = [];
    let globalHistory = {};
    let priceChartInstance = null;

    let currentStateContext = 'CA';
    let userLocation = null;
    let searchLocationMarker = null;

    // Autocomplete state
    let autocompleteItems = [];
    let activeAutocompleteIndex = -1;
    let geocodeAbortController = null;

    // User Preferences State
    let isDarkMode = localStorage.getItem('theme') === 'dark';
    let gasPref = localStorage.getItem('gasPref') || 'regular';

    // Safely parse data (Handles BOTH new Array format [4.84, 5.20] and old {"Regular": "$4.84"} format)
    const getValidPrice = (val) => {
        if (val === null || val === undefined || val === "N/A") return Infinity;
        if (typeof val === 'string') return parseFloat(val.replace('$', '').trim());
        console.log(parseFloat(val))
        return parseFloat(val);
    };

    const formatPriceDisplay = (val) => {
        if (val === null || val === undefined || val === Infinity) return "N/A";
        return `$${val.toFixed(2)}`;
    };

    function getDistanceMiles(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
        return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    }

    // --- Preferences Initializers ---
    function initPreferences() {
        if (isDarkMode) {
            document.body.classList.add('dark-mode');
            document.getElementById('themeToggle').innerText = '☀️';
        }
        document.getElementById('btn-regular').classList.remove('active');
        document.getElementById('btn-premium').classList.remove('active');
        document.getElementById(`btn-${gasPref}`).classList.add('active');
    }

    function toggleTheme() {
        isDarkMode = document.body.classList.toggle('dark-mode');
        localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
        document.getElementById('themeToggle').innerText = isDarkMode ? '☀️' : '🌙';
        setMapTiles();

        if(document.getElementById('chartModal').classList.contains('active')){
            const currentTitle = document.getElementById('chartTitle').innerText;
            const [, locationStr] = currentTitle.split(': ');
            const [city, state] = locationStr.split(', ');
            openHistoryModal(state, city);
        }
    }

    function setGasPref(pref) {
        gasPref = pref;
        localStorage.setItem('gasPref', pref);

        document.getElementById('btn-regular').classList.remove('active');
        document.getElementById('btn-premium').classList.remove('active');
        document.getElementById(`btn-${pref}`).classList.add('active');

        // Re-render map pins so the zoom badges display the newly selected gas preference
        if (globalStoreData.length > 0) {
            renderMap(globalStoreData);
        }

        const activeTab = document.querySelector('.tab.active');
        if(activeTab) {
            const activeTabId = activeTab.id.replace('tab-', '');
            switchTab(activeTabId);
        }
    }

    // --- Map Logic ---
    function setMapTiles() {
        if (mapTileLayer) map.removeLayer(mapTileLayer);
        const url = isDarkMode ?
            'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' :
            'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        mapTileLayer = L.tileLayer(url, { attribution: '&copy; CARTO', maxZoom: 19 }).addTo(map);
    }

    // Triggered on zoom to toggle the visibility of the text badges
    function checkZoomLevel() {
        if (map.getZoom() >= 10) {
            document.getElementById('map').classList.add('map-show-prices');
        } else {
            document.getElementById('map').classList.remove('map-show-prices');
        }
    }

    function initMap() {
        map = L.map('map', {zoomControl: false}).setView([39.8283, -98.5795], 4);
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        setMapTiles();
        markersLayer = L.layerGroup().addTo(map);

        // Listen for map zooms to toggle the CSS class
        map.on('zoomend', checkZoomLevel);

        const searchInputEl = document.getElementById('searchInput');
        const dropdownEl = document.getElementById('autocompleteDropdown');

        searchInputEl.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            switchTab('search');
            renderStoresList(query);

            if (query.length === 0) {
                closeAutocompleteDropdown();
                return;
            }
            debouncedAutocomplete(query);
        });

        searchInputEl.addEventListener('keydown', (e) => {
            if (!dropdownEl.classList.contains('active')) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveAutocompleteSelection(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveAutocompleteSelection(-1);
            } else if (e.key === 'Enter') {
                if (activeAutocompleteIndex >= 0) {
                    e.preventDefault();
                    selectAutocompleteItem(activeAutocompleteIndex);
                }
            } else if (e.key === 'Escape') {
                closeAutocompleteDropdown();
            }
        });

        searchInputEl.addEventListener('focus', () => {
            const query = searchInputEl.value.toLowerCase().trim();
            if (query.length > 0 && autocompleteItems.length > 0) {
                dropdownEl.classList.add('active');
            }
        });

        document.addEventListener('click', (e) => {
            const wrapper = document.getElementById('searchWrapper');
            if (wrapper && !wrapper.contains(e.target)) {
                closeAutocompleteDropdown();
            }
        });
    }

    // --- Autocomplete / Geocoding Logic ---
    function debounce(fn, delay) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    function getStoreMatches(query) {
        return globalStoreData.filter(s =>
            s.city.toLowerCase().includes(query) ||
            s.address.toLowerCase().includes(query) ||
            s.state.toLowerCase().includes(query)
        ).slice(0, 5);
    }

    async function getGeoMatches(query) {
        try {
            if (geocodeAbortController) geocodeAbortController.abort();
            geocodeAbortController = new AbortController();
            const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(query)}`;
            const res = await fetch(url, {
                signal: geocodeAbortController.signal,
                headers: { 'Accept-Language': 'en-US' }
            });
            if (!res.ok) return [];
            return await res.json();
        } catch (e) {
            if (e.name === 'AbortError') return [];
            console.warn('Geocode lookup failed:', e);
            return [];
        }
    }

    const debouncedAutocomplete = debounce(async (query) => {
        const dropdownEl = document.getElementById('autocompleteDropdown');
        const storeMatches = getStoreMatches(query);

        // Show store matches immediately, then fill in location results once they arrive
        renderAutocompleteDropdown(storeMatches, [], query, true);

        const geoMatches = query.length >= 2 ? await getGeoMatches(query) : [];

        // Guard against stale responses if the input changed while we were waiting
        if (document.getElementById('searchInput').value.toLowerCase().trim() === query) {
            renderAutocompleteDropdown(storeMatches, geoMatches, query, false);
        }
    }, 400);

    function getGeoMeta(result) {
        const type = result.addresstype || result.type || 'place';
        const metaMap = {
            postcode: { icon: '📮', label: 'Zip Code' },
            city: { icon: '🏙️', label: 'City' },
            town: { icon: '🏙️', label: 'Town' },
            village: { icon: '🏙️', label: 'Village' },
            hamlet: { icon: '🏙️', label: 'Town' },
            county: { icon: '📍', label: 'County' },
            state: { icon: '📍', label: 'State' },
            suburb: { icon: '📍', label: 'Neighborhood' },
            neighbourhood: { icon: '📍', label: 'Neighborhood' },
            administrative: { icon: '📍', label: 'Area' }
        };
        return metaMap[type] || { icon: '📍', label: 'Location' };
    }

    function shortGeoName(result) {
        const addr = result.address || {};
        const main = addr.city || addr.town || addr.village || addr.hamlet || addr.county || result.display_name.split(',')[0];
        let state = '';
        if (addr['ISO3166-2-lvl4']) state = addr['ISO3166-2-lvl4'].split('-')[1];
        else if (addr.state) state = addr.state;

        if (addr.postcode && (result.addresstype === 'postcode')) {
            return state ? `${addr.postcode} \u2014 ${main}, ${state}` : `${addr.postcode} \u2014 ${main}`;
        }
        return state ? `${main}, ${state}` : main;
    }

    function renderAutocompleteDropdown(storeMatches, geoMatches, query, isLoadingGeo) {
        const dropdown = document.getElementById('autocompleteDropdown');
        autocompleteItems = [];
        activeAutocompleteIndex = -1;

        let html = '';

        if (storeMatches.length > 0) {
            html += `<div class="autocomplete-section-label">Costco Stores</div>`;
            storeMatches.forEach(store => {
                const idx = autocompleteItems.length;
                autocompleteItems.push({ type: 'store', data: store });
                html += `
                    <div class="autocomplete-item" data-index="${idx}" onclick="selectAutocompleteItem(${idx})">
                        <span class="ac-icon">🛒</span>
                        <div class="ac-text">
                            <div class="ac-title">${store.city}, ${store.state}</div>
                            <div class="ac-subtitle">${store.address}</div>
                        </div>
                    </div>`;
            });
        }

        if (geoMatches.length > 0) {
            html += `<div class="autocomplete-section-label">Locations</div>`;
            geoMatches.forEach(result => {
                const idx = autocompleteItems.length;
                autocompleteItems.push({ type: 'place', data: result });
                const meta = getGeoMeta(result);
                html += `
                    <div class="autocomplete-item" data-index="${idx}" onclick="selectAutocompleteItem(${idx})">
                        <span class="ac-icon">${meta.icon}</span>
                        <div class="ac-text">
                            <div class="ac-title">${shortGeoName(result)}</div>
                            <div class="ac-subtitle">${meta.label}</div>
                        </div>
                    </div>`;
            });
        } else if (isLoadingGeo && query.length >= 2) {
            html += `<div class="autocomplete-loading">Searching locations…</div>`;
        }

        if (html === '') {
            if (query.length >= 1) {
                html = `<div class="autocomplete-empty">No matches found</div>`;
            } else {
                dropdown.classList.remove('active');
                dropdown.innerHTML = '';
                return;
            }
        }

        dropdown.innerHTML = html;
        dropdown.classList.add('active');
    }

    function moveAutocompleteSelection(delta) {
        const items = document.querySelectorAll('#autocompleteDropdown .autocomplete-item');
        if (items.length === 0) return;
        activeAutocompleteIndex += delta;
        if (activeAutocompleteIndex < 0) activeAutocompleteIndex = items.length - 1;
        if (activeAutocompleteIndex >= items.length) activeAutocompleteIndex = 0;
        items.forEach((el, i) => el.classList.toggle('active', i === activeAutocompleteIndex));
        items[activeAutocompleteIndex].scrollIntoView({ block: 'nearest' });
    }

    function selectAutocompleteItem(idx) {
        const item = autocompleteItems[idx];
        if (!item) return;

        if (item.type === 'store') {
            flyToStore(item.data);
        } else {
            flyToGeoResult(item.data);
        }
        closeAutocompleteDropdown();
        document.getElementById('searchInput').blur();
    }

    function closeAutocompleteDropdown() {
        const dropdown = document.getElementById('autocompleteDropdown');
        dropdown.classList.remove('active');
        dropdown.innerHTML = '';
        autocompleteItems = [];
        activeAutocompleteIndex = -1;
    }

    function flyToStore(store) {
        map.flyTo([store.lat, store.lng], 14, { duration: 1.5 });
        map.once('moveend', () => store.leafletMarker && store.leafletMarker.openPopup());
        if (window.innerWidth <= 768) {
            document.getElementById('map').scrollIntoView({behavior: 'smooth'});
        }
    }

    function flyToGeoResult(result) {
        const south = parseFloat(result.boundingbox[0]);
        const north = parseFloat(result.boundingbox[1]);
        const west = parseFloat(result.boundingbox[2]);
        const east = parseFloat(result.boundingbox[3]);

        map.flyToBounds([[south, west], [north, east]], { duration: 1.5, maxZoom: 13, padding: [40, 40] });

        // Treat the searched location like "Near Me" so the sidebar surfaces nearby stores too
        userLocation = { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };

        if (searchLocationMarker) map.removeLayer(searchLocationMarker);
        searchLocationMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
            radius: 8, fillColor: "#f59e0b", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
        }).addTo(map).bindPopup(`<b>${shortGeoName(result)}</b>`);

        map.once('moveend', () => switchTab('nearby'));

        if (window.innerWidth <= 768) {
            document.getElementById('map').scrollIntoView({behavior: 'smooth'});
        }
    }

    async function detectUserState() {
        try {
            const res = await fetch('https://ipapi.co/region_code/');
            if (res.ok) {
                const code = await res.text();
                if (code && code.length === 2) currentStateContext = code.toUpperCase();
            }
        } catch (e) {}
    }

async function loadData() {
        try {
            // 1. Cache-buster to bypass Cloudflare/Browser cache
            const cb = new Date().getTime();
            const [pricesRes, storesRes, _] = await Promise.all([
                fetch(`us_prices.json?t=${cb}`),
                fetch(`us_stores.json?t=${cb}`),
                detectUserState()
            ]);

            const priceData = await pricesRes.json();
            const storeData = await storesRes.json();

            // 2. FIX: Standard string sort. (YYYY-MM-DD HH:MM sorts perfectly this way)
            // This prevents Safari/iOS from breaking the sort with "Invalid Date"
            const timestamps = Object.keys(priceData).sort();
            const latestTimestamp = timestamps[timestamps.length - 1];

            document.getElementById("lastUpdated").innerText = `Last Updated: ${latestTimestamp}`;

            // Populate History
            timestamps.forEach(ts => {
                // Replacing hyphens with slashes keeps History Dates working in Safari
                const d = new Date(ts.replace(/-/g, '/'));
                const dayStr = d.toLocaleDateString();

                for (const stateCode in priceData[ts]) {
                    for (const cityName in priceData[ts][stateCode]) {
                        const key = `${stateCode}_${cityName}`;
                        if (!globalHistory[key]) globalHistory[key] = [];

                        const pData = priceData[ts][stateCode][cityName];
                        let rRaw, pRaw;

                        if (Array.isArray(pData)) {
                            rRaw = pData[0];
                            pRaw = pData[1];
                        } else {
                            rRaw = pData.Regular ?? pData.regular;
                            pRaw = pData.Premium ?? pData.premium;
                        }

                        globalHistory[key].push({
                            rawDate: d,
                            dayStr: dayStr,
                            reg: getValidPrice(rRaw),
                            prem: getValidPrice(pRaw)
                        });
                    }
                }
            });

            // Parse Map & Sidebar stores
            const timestampedPrices = priceData[latestTimestamp];
            for (const stateCode in storeData) {
                if (!timestampedPrices[stateCode]) continue;
                for (const [cityName, info] of Object.entries(storeData[stateCode])) {

                    const pData = timestampedPrices[stateCode][cityName];

                    if (pData) {
                        let rRaw, pRaw;

                        if (Array.isArray(pData)) {
                            rRaw = pData[0];
                            pRaw = pData[1];
                        } else {
                            rRaw = pData.Regular ?? pData.regular;
                            pRaw = pData.Premium ?? pData.premium;
                        }

                        const regVal = getValidPrice(rRaw);
                        const premVal = getValidPrice(pRaw);

                        globalStoreData.push({
                            state: stateCode, city: cityName, address: info.address,
                            lat: info.lat, lng: info.lng, url: info.url,
                            regularStr: formatPriceDisplay(regVal),
                            premiumStr: formatPriceDisplay(premVal),
                            regVal: regVal,
                            premVal: premVal
                        });
                    }
                }
            }

            renderMap(globalStoreData);
            switchTab('nearby');

            if (globalStoreData.length > 0) {
                const bounds = L.latLngBounds(globalStoreData.map(s => [s.lat, s.lng]).filter(coords => coords[0] && coords[1]));
                map.fitBounds(bounds, { padding: [30, 30] });
                checkZoomLevel();
            }
        } catch (error) {
            console.error('Error fetching data:', error);
            document.getElementById("sidebarContent").innerHTML = `<p style="text-align:center; color:var(--costco-red); margin-top:30px;">Error Loading Data.</p>`;
        }
    }
    function renderMap(dataArray) {
        markersLayer.clearLayers();
        dataArray.forEach(store => {
            if (!store.lat || !store.lng) {
                console.warn(`Skipping ${store.city} - Missing coordinates`);
                return;
            }

            // Decide which price to show hovering over the pin
            const displayPrice = gasPref === 'regular' ? store.regularStr : store.premiumStr;
            const priceColor = gasPref === 'regular' ? '#059669' : '#E31837';

            // Generate a custom dynamic HTML pin
            const dynamicPin = L.divIcon({
                className: 'costco-custom-icon',
                html: `
                    <div style="position:relative;">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#E31837" stroke="#ffffff" stroke-width="2"/>
                            <circle cx="12" cy="9" r="3.5" fill="#ffffff"/>
                        </svg>
                        <div class="pin-price-badge" style="color: ${priceColor}; border-color: ${priceColor};">
                            ${displayPrice || 'N/A'}
                        </div>
                    </div>
                `,
                iconSize: [36, 36],
                iconAnchor: [18, 36],
                popupAnchor: [0, -32]
            });

            const marker = L.marker([store.lat, store.lng], {icon: dynamicPin});
            const safeCity = store.city.replace(/'/g, "\\'");

            marker.bindPopup(`
                <div class="popup-store-name">${store.city}, ${store.state}</div>
                <div class="popup-address">${store.address}</div>
                <div class="popup-prices-grid">
                    <div class="popup-price-box"><span>Regular</span><strong>${store.regularStr || 'N/A'}</strong></div>
                    <div class="popup-price-box"><span>Premium</span><strong>${store.premiumStr || 'N/A'}</strong></div>
                </div>
                <a href="${store.url}" target="_blank" class="popup-btn popup-btn-outline">View Store</a>
                <button class="popup-btn" style="margin-top:8px;" onclick="openHistoryModal('${store.state}', '${safeCity}')">📈 Price History</button>
            `);
            marker.addTo(markersLayer);
            store.leafletMarker = marker;
        });
    }

    // --- History Chart Modal Logic ---
    function openHistoryModal(state, city) {
        const key = `${state}_${city}`;
        const history = globalHistory[key];

        if (!history || history.length === 0) {
            alert(`No price history available for ${city}, ${state}.`);
            return;
        }

        document.getElementById('chartModal').classList.add('active');
        document.getElementById('chartTitle').innerText = `Price History: ${city}, ${state}`;

        const dedupedHistory = [];
        const seenDates = new Set();
        for (let i = history.length - 1; i >= 0; i--) {
            if (!seenDates.has(history[i].dayStr)) {
                seenDates.add(history[i].dayStr);
                dedupedHistory.unshift(history[i]);
            }
        }

        const labels = dedupedHistory.map(h => h.rawDate);
        const regData = dedupedHistory.map(h => h.reg === Infinity ? null : h.reg);
        const premData = dedupedHistory.map(h => h.prem === Infinity ? null : h.prem);

        const textColor = isDarkMode ? '#f8fafc' : '#1e293b';
        const gridColor = isDarkMode ? '#334155' : '#e2e8f0';

        const ctx = document.getElementById('priceChart').getContext('2d');
        if (priceChartInstance) priceChartInstance.destroy();

        priceChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Regular',
                        data: regData,
                        borderColor: '#059669',
                        backgroundColor: '#059669',
                        tension: 0.1,
                        pointRadius: 4,
                        spanGaps: true
                    },
                    {
                        label: 'Premium',
                        data: premData,
                        borderColor: '#E31837',
                        backgroundColor: '#E31837',
                        tension: 0.1,
                        pointRadius: 4,
                        spanGaps: true
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: textColor } },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.dataset.label + ': $' + context.raw.toFixed(2);
                            }
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
                        ticks: { color: textColor, callback: function(value) { return '$' + value.toFixed(2); } },
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

    // --- Sidebar Render Logic ---
    function renderStoresList(searchTerm) {
        const container = document.getElementById("sidebarContent");
        container.innerHTML = "";
        const filtered = globalStoreData.filter(s =>
            s.city.toLowerCase().includes(searchTerm) ||
            s.address.toLowerCase().includes(searchTerm) ||
            s.state.toLowerCase().includes(searchTerm)
        );

        if (filtered.length === 0) {
            container.innerHTML = `<p style="text-align:center; color:var(--text-muted); margin-top:40px;">No stores found.</p>`;
            return;
        }
        filtered.forEach(store => container.appendChild(createStoreCard(store, gasPref)));
    }

    function getStoreCount(stateCode) {
        return globalStoreData.filter(s => s.state === stateCode).length;
    }

    function renderLowestPrices(stateOverride = null) {
        const container = document.getElementById("sidebarContent");
        container.innerHTML = "";

        const availableStates = [...new Set(globalStoreData.map(s => s.state))].sort();
        if (availableStates.length === 0) return;

        if (stateOverride && availableStates.includes(stateOverride)) {
            currentStateContext = stateOverride;
        } else if (!availableStates.includes(currentStateContext)) {
            currentStateContext = availableStates[0];
        }

        let dropdownHTML = `
            <div class="state-selector-box">
                <label>State Leaderboard:</label>
                <select onchange="renderLowestPrices(this.value)">
                    ${availableStates.map(s => `<option value="${s}" ${s === currentStateContext ? 'selected' : ''}>${s} - ${getStoreCount(s)} stores</option>`).join('')}
                </select>
            </div>
        `;
        container.innerHTML += dropdownHTML;

        const stateData = globalStoreData.filter(s => s.state === currentStateContext);
        const isReg = gasPref === 'regular';

        const sortedData = [...stateData]
            .filter(s => isReg ? s.regVal !== Infinity : s.premVal !== Infinity)
            .sort((a, b) => isReg ? a.regVal - b.regVal : a.premVal - b.premVal)
            .slice(0, 10);

        container.innerHTML += `<div class="leaderboard-header">Top 10 Cheapest ${isReg ? 'Regular' : 'Premium'}</div>`;
        if (sortedData.length === 0) {
            container.innerHTML += `<p style="text-align:center; color:var(--text-muted); font-size: 13px;">No pricing data found for this state.</p>`;
        }
        sortedData.forEach((store, index) => container.appendChild(createStoreCard(store, gasPref, index)));
    }

    function renderNearbyPrices() {
        const container = document.getElementById("sidebarContent");

        if (!userLocation) {
            container.innerHTML = `
                <div style="text-align:center; margin-top:50px;">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--costco-blue)" stroke-width="2" style="margin-bottom:15px;">
                        <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
                    </svg>
                    <h3 style="margin-bottom: 5px;">Find Local Gas</h3>
                    <p style="color:var(--text-muted); font-size:14px; padding: 0 10px;">We need your location to find the cheapest Costco gas near you.</p>
                    <button class="btn-action" onclick="triggerFindMe()" style="margin-top:15px; margin-left:auto; margin-right:auto;">📍 Detect Location</button>
                </div>
            `;
            return;
        }

        let nearbyStores = globalStoreData.filter(s => s.lat && s.lng).map(s => {
            return { ...s, distance: getDistanceMiles(userLocation.lat, userLocation.lng, s.lat, s.lng) };
        }).filter(s => s.distance <= 50);

        if (nearbyStores.length === 0) {
            container.innerHTML = `<p style="text-align:center; color:var(--text-muted); margin-top:40px;">No Costco locations found within a 50-mile radius.</p>`;
            return;
        }

        const isReg = gasPref === 'regular';
        const sortedData = [...nearbyStores]
            .filter(s => isReg ? s.regVal !== Infinity : s.premVal !== Infinity)
            .sort((a, b) => {
                const valA = isReg ? a.regVal : a.premVal;
                const valB = isReg ? b.regVal : b.premVal;
                return valA !== valB ? valA - valB : a.distance - b.distance;
            }).slice(0, 10);

        container.innerHTML = `<div class="leaderboard-header">Cheapest ${isReg ? 'Regular' : 'Premium'} (Within 50 Miles)</div>`;
        sortedData.forEach((store, index) => container.appendChild(createStoreCard(store, gasPref, index, true)));
    }

    function getMedal(index) {
        if (index === 0) return '🥇';
        if (index === 1) return '🥈';
        if (index === 2) return '🥉';
        return `<span style="font-size:13px; color:var(--text-muted); margin-right:4px;">#${index + 1}</span>`;
    }

    function createStoreCard(store, highlight = null, index = null, showDistance = false) {
        const div = document.createElement('div');
        div.className = 'store-card';

        let regClass = highlight === 'regular' ? 'highlight' : '';
        let premClass = highlight === 'premium' ? 'highlight' : '';

        let badgeHtml = '';
        if (showDistance && store.distance !== undefined) {
            badgeHtml = `<span class="distance-badge">${store.distance.toFixed(1)} mi</span>`;
        } else if (index !== null) {
            badgeHtml = `<span class="medal">${getMedal(index)}</span>`;
        }

        const safeCity = store.city.replace(/'/g, "\\'");

        div.innerHTML = `
            <h3><span>${store.city}, ${store.state}</span> ${badgeHtml}</h3>
            <div class="address">${store.address}</div>
            <div class="prices">
                <div class="price-tag ${regClass}">
                    <span>Regular</span><span class="val">${store.regularStr || 'N/A'}</span>
                </div>
                <div class="price-tag ${premClass}">
                    <span>Premium</span><span class="val">${store.premiumStr || 'N/A'}</span>
                </div>
            </div>
            <button class="btn-action" style="width:100%; background: transparent; color: var(--costco-blue); border: 2px solid var(--costco-blue);"
                onclick="event.stopPropagation(); openHistoryModal('${store.state}', '${safeCity}')">
                📈 View Price History
            </button>
        `;

        div.onclick = () => flyToStore(store);
        return div;
    }

    function switchTab(tabName) {
        document.getElementById('tab-search').classList.remove('active');
        document.getElementById('tab-lowest').classList.remove('active');
        document.getElementById('tab-nearby').classList.remove('active');

        if (tabName === 'search') {
            document.getElementById('tab-search').classList.add('active');
            renderStoresList(document.getElementById('searchInput').value.toLowerCase());
        } else if (tabName === 'lowest') {
            document.getElementById('tab-lowest').classList.add('active');
            renderLowestPrices();
        } else if (tabName === 'nearby') {
            document.getElementById('tab-nearby').classList.add('active');
            renderNearbyPrices();
        }
    }

    function triggerFindMe() {
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser.");
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };

                L.circleMarker([userLocation.lat, userLocation.lng], {
                    radius: 8, fillColor: "#3b82f6", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
                }).addTo(map).bindPopup("<b>You are here!</b>").openPopup();

                map.flyTo([userLocation.lat, userLocation.lng], 10, {duration: 2});

                if (globalStoreData.length > 0) {
                    let closestStore = globalStoreData.find(s => s.lat && s.lng) || globalStoreData[0];
                    let minDistance = Infinity;
                    globalStoreData.forEach(s => {
                        if(!s.lat || !s.lng) return;
                        let distance = Math.pow(s.lat - userLocation.lat, 2) + Math.pow(s.lng - userLocation.lng, 2);
                        if (distance < minDistance) {
                            minDistance = distance;
                            closestStore = s;
                        }
                    });
                    currentStateContext = closestStore.state;
                }

                switchTab('nearby');
            },
            (error) => alert("Unable to retrieve your location. Check browser permissions.")
        );
    }

    initPreferences();
    initMap();
    loadData();
