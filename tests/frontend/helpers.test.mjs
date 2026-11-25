// Unit tests for the pure helpers in public/js (prices.js, geo.js, hours.js, time.js,
// stores.js, dom.js, storage.js). Run with: npm run test:unit
import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    getValidPrice, formatPriceDisplay, extractGradePrices, hasGradeData,
    filterStoresForCurrentGrade, getVisibleStoreGrades, getTrendArrow,
} from '../../public/js/prices.js';
import { getDistanceMiles, distanceToSegmentMiles, minDistanceToRouteMiles, getRouteBoundsPadded } from '../../public/js/geo.js';
import { formatGasTime, getGasStatus, groupGasHours } from '../../public/js/hours.js';
import { parseScraperTimestamp, getRelativeTimeLabel, formatLastUpdatedLabel, PRICES_STALE_HOURS } from '../../public/js/time.js';
import { storeMatchesQuery, directionsUrl, formatAddress } from '../../public/js/stores.js';
import { escapeHtml } from '../../public/js/dom.js';
import { fillCost, GALLON_LIMITS, readCarSetting, ROAD_FACTOR, routeStopCosts } from '../../public/js/fillup.js';
import { loadJsonPref } from '../../public/js/storage.js';

const store = (over = {}) => ({
    state: 'CA', city: 'Turlock', address: '2500 GEER RD, TURLOCK, CA 95380',
    lat: 37.5091, lng: -120.8466,
    regVal: 4.45, premVal: 4.85, dieselVal: Infinity,
    ...over,
});

describe('prices', () => {
    test('getValidPrice parses numbers and price strings, and treats missing as Infinity', () => {
        assert.equal(getValidPrice(4.45), 4.45);
        assert.equal(getValidPrice('$4.45 '), 4.45);
        assert.equal(getValidPrice(null), Infinity);
        assert.equal(getValidPrice(undefined), Infinity);
        assert.equal(getValidPrice('N/A'), Infinity);
    });

    test('formatPriceDisplay shows two decimals, or N/A when there is no price', () => {
        assert.equal(formatPriceDisplay(4.5), '$4.50');
        assert.equal(formatPriceDisplay(Infinity), 'N/A');
        assert.equal(formatPriceDisplay(NaN), 'N/A');
        assert.equal(formatPriceDisplay(null), 'N/A');
    });

    test('extractGradePrices reads 3-element, legacy 2-element and object snapshots', () => {
        assert.deepEqual(extractGradePrices([4.45, 4.85, 4.99]), [4.45, 4.85, 4.99]);
        assert.deepEqual(extractGradePrices([4.45, 4.85]), [4.45, 4.85, undefined]);
        assert.deepEqual(extractGradePrices({ Regular: 4.1, premium: 4.5 }), [4.1, 4.5, undefined]);
        assert.deepEqual(extractGradePrices(null), [undefined, undefined, undefined]);
    });

    test('diesel view hides stores without diesel; other grades keep every store', () => {
        const withDiesel = store({ city: 'Tracy', dieselVal: 4.99 });
        const without = store();
        assert.equal(hasGradeData(withDiesel, 'diesel'), true);
        assert.equal(hasGradeData(without, 'diesel'), false);
        assert.deepEqual(filterStoresForCurrentGrade([withDiesel, without], 'diesel'), [withDiesel]);
        assert.deepEqual(filterStoresForCurrentGrade([withDiesel, without], 'regular'), [withDiesel, without]);
        assert.deepEqual(getVisibleStoreGrades(without), ['regular', 'premium']);
        assert.deepEqual(getVisibleStoreGrades(withDiesel), ['regular', 'premium', 'diesel']);
    });

    test('storeMatchesQuery matches city, address or state', () => {
        assert.equal(storeMatchesQuery(store(), 'turl'), true);
        assert.equal(storeMatchesQuery(store(), 'geer'), true);
        assert.equal(storeMatchesQuery(store(), 'ca'), true);
        assert.equal(storeMatchesQuery(store(), 'austin'), false);
    });
});

describe('distances and routes', () => {
    test('getDistanceMiles: LA to San Francisco is about 347 miles', () => {
        const d = getDistanceMiles(34.0522, -118.2437, 37.7749, -122.4194);
        assert.ok(Math.abs(d - 347) < 3, `got ${d}`);
        assert.equal(getDistanceMiles(37, -120, 37, -120), 0);
    });

    test('distanceToSegmentMiles measures to the nearest point, clamped to the ends', () => {
        // A point one degree of latitude (~69 mi) north of the middle of an east-west segment.
        const mid = distanceToSegmentMiles(1, 0.5, 0, 0, 0, 1);
        assert.ok(Math.abs(mid - 69.1) < 0.5, `got ${mid}`);
        // Beyond the east end, the distance is to the end point itself.
        const beyond = distanceToSegmentMiles(0, 2, 0, 0, 0, 1);
        assert.ok(Math.abs(beyond - getDistanceMiles(0, 2, 0, 1)) < 0.01);
        // A zero-length segment is a point.
        assert.ok(Math.abs(distanceToSegmentMiles(1, 0, 0, 0, 0, 0) - getDistanceMiles(1, 0, 0, 0)) < 0.01);
    });

    test('minDistanceToRouteMiles takes the closest segment, or the single point', () => {
        const route = [[0, 0], [0, 1], [1, 1]];
        assert.ok(minDistanceToRouteMiles(0.5, 1, route) < 0.01); // on the second leg
        assert.equal(minDistanceToRouteMiles(1, 0, [[0, 0]]), getDistanceMiles(1, 0, 0, 0));
    });

    test('getRouteBoundsPadded pads the route box by the buffer in miles', () => {
        const b = getRouteBoundsPadded([[37, -121], [38, -120]], 69);
        assert.ok(Math.abs(b.minLat - 36) < 1e-9);
        assert.ok(Math.abs(b.maxLat - 39) < 1e-9);
        // Longitude padding is wider than latitude padding away from the equator.
        assert.ok(-121 - b.minLng > 1);
        assert.ok(b.maxLng - -120 > 1);
    });
});

describe('gas hours', () => {
    // 2026-06-29 is a Monday; Pacific time is UTC-7 in summer.
    const pacific = (day, hhmm) => new Date(`2026-06-${day}T${hhmm}:00-07:00`);
    const hours = {
        mon: ['06:00', '22:00'], tue: ['06:00', '22:00'], wed: ['06:00', '22:00'],
        thu: ['06:00', '22:00'], fri: ['06:00', '02:00'], sat: ['00:00', '00:00'], sun: null,
    };
    const s = store({ gasHours: hours, tz: 'America/Los_Angeles' });

    test('formatGasTime uses 12-hour times and drops :00', () => {
        assert.equal(formatGasTime('06:00'), '6 AM');
        assert.equal(formatGasTime('20:30'), '8:30 PM');
        assert.equal(formatGasTime('00:00'), '12 AM');
        assert.equal(formatGasTime('12:15'), '12:15 PM');
    });

    test('open, closing soon, before opening and after closing', () => {
        assert.deepEqual(getGasStatus(s, pacific('29', '12:00')),
            { isOpen: true, closingSoon: false, text: 'Open · closes 10 PM' });
        assert.deepEqual(getGasStatus(s, pacific('29', '21:15')),
            { isOpen: true, closingSoon: true, text: 'Closing soon · 10 PM' });
        assert.deepEqual(getGasStatus(s, pacific('29', '05:00')),
            { isOpen: false, closingSoon: false, text: 'Closed · opens 6 AM' });
        assert.equal(getGasStatus(s, pacific('29', '23:00')).text, 'Closed · opens tomorrow 6 AM');
    });

    test('hours that run past midnight, 24-hour days and closed days', () => {
        // Friday 06:00-02:00: still open at 01:00 on Saturday, and late Friday says "tomorrow".
        assert.equal(getGasStatus(s, new Date('2026-07-03T23:30:00-07:00')).text, 'Open · closes 2 AM tomorrow');
        assert.equal(getGasStatus(s, new Date('2026-07-04T01:00:00-07:00')).text, 'Closing soon · 2 AM');
        assert.equal(getGasStatus(s, new Date('2026-07-04T15:00:00-07:00')).text, 'Open 24 hours');
        // Sunday is closed: the next opening is Monday ("tomorrow").
        assert.equal(getGasStatus(s, new Date('2026-07-05T10:00:00-07:00')).text, 'Closed · opens tomorrow 6 AM');
    });

    test('uses the station time zone, not the browser one', () => {
        const ny = store({ gasHours: hours, tz: 'America/New_York' });
        // 20:30 Pacific is 23:30 Eastern: the New York station is closed.
        assert.equal(getGasStatus(ny, pacific('29', '20:30')).isOpen, false);
        assert.equal(getGasStatus(s, pacific('29', '20:30')).isOpen, true);
    });

    test('no hours or no time zone gives no status', () => {
        assert.equal(getGasStatus(store({ gasHours: null, tz: 'America/Los_Angeles' })), null);
        assert.equal(getGasStatus(store({ gasHours: hours, tz: null })), null);
    });

    test('groupGasHours merges consecutive days with the same hours', () => {
        assert.deepEqual(groupGasHours(hours), [
            { label: 'Mon–Thu', text: '6 AM – 10 PM' },
            { label: 'Fri', text: '6 AM – 2 AM' },
            { label: 'Sat', text: '12 AM – 12 AM' },
            { label: 'Sun', text: 'Closed' },
        ]);
    });
});

describe('timestamps and the last-updated label', () => {
    afterEach(() => mock.timers.reset());
    const at = (iso) => mock.timers.enable({ apis: ['Date'], now: new Date(iso) });

    test('scraper timestamps are Pacific wall-clock time, summer and winter', () => {
        assert.equal(parseScraperTimestamp('2026-06-30 10:53').toISOString(), '2026-06-30T17:53:00.000Z');
        assert.equal(parseScraperTimestamp('2026-01-15 08:00').toISOString(), '2026-01-15T16:00:00.000Z');
        assert.equal(parseScraperTimestamp('2026-06-30T10:53:00Z').toISOString(), '2026-06-30T10:53:00.000Z');
        assert.equal(parseScraperTimestamp(''), null);
        assert.equal(parseScraperTimestamp('not a date'), null);
    });

    test('recent prices read as fresh', () => {
        at('2026-06-30T18:00:00Z'); // 11:00 Pacific
        assert.equal(formatLastUpdatedLabel('2026-06-30 11:00').text, 'Updated just now');
        assert.equal(formatLastUpdatedLabel('2026-06-30 10:35').text, 'Updated 25 min ago');
        const twoHours = formatLastUpdatedLabel('2026-06-30 09:00');
        assert.equal(twoHours.text, 'Updated 2 hr ago');
        assert.equal(twoHours.stale, false);
    });

    test(`prices ${PRICES_STALE_HOURS}+ hours old are flagged as possibly out of date`, () => {
        at('2026-06-30T18:00:00Z');
        const justUnder = formatLastUpdatedLabel('2026-06-30 07:01');
        assert.equal(justUnder.stale, false);
        const stale = formatLastUpdatedLabel('2026-06-30 07:00');
        assert.equal(stale.stale, true);
        assert.equal(stale.text, 'Updated 4 hr ago · may be out of date');
        assert.match(stale.title, /may be out of date/);
        assert.equal(formatLastUpdatedLabel('2026-06-27 11:00').text, 'Updated 3 days ago · may be out of date');
    });

    test('an unreadable timestamp is neither fresh nor stale', () => {
        assert.deepEqual(formatLastUpdatedLabel(null), { text: 'Update time unknown', title: '', stale: false });
    });

    test('getRelativeTimeLabel describes the trend baseline', () => {
        at('2026-06-30T18:00:00Z');
        assert.equal(getRelativeTimeLabel('2026-06-30 10:45'), 'the last hour');
        assert.equal(getRelativeTimeLabel('2026-06-29 11:00'), '24h ago');
        assert.equal(getRelativeTimeLabel('2026-06-27 11:00'), '3d ago');
        assert.equal(getRelativeTimeLabel(null), 'the last update');
    });
});

describe('formatting', () => {
    test('getTrendArrow shows direction and size in cents, with screen-reader text', () => {
        const down = getTrendArrow(4.41, 4.45, '72h ago');
        assert.match(down, /trend-down/);
        assert.match(down, /▼/);
        assert.match(down, /4¢/);
        assert.match(down, /down 4 cents/);
        assert.match(down, /since 72h ago/);
        assert.match(getTrendArrow(4.51, 4.45), /trend-up[\s\S]*6¢/);
        assert.match(getTrendArrow(4.45, 4.452), /trend-flat/);
        assert.equal(getTrendArrow(4.45, undefined), '');
        assert.equal(getTrendArrow(Infinity, 4.45), '');
        assert.doesNotMatch(getTrendArrow(4.4, 4.5, '<b>'), /<b>/);
    });

    test('directionsUrl builds links for each app, falling back to the address', () => {
        const s = store();
        assert.equal(directionsUrl(s), 'https://www.google.com/maps/dir/?api=1&destination=37.5091%2C-120.8466');
        assert.equal(directionsUrl(s, 'apple'), 'https://maps.apple.com/?daddr=37.5091%2C-120.8466&dirflg=d');
        assert.equal(directionsUrl(s, 'waze'), 'https://waze.com/ul?ll=37.5091%2C-120.8466&navigate=yes');
        const noCoords = store({ lat: null, lng: null });
        assert.match(directionsUrl(noCoords, 'waze'), /^https:\/\/waze\.com\/ul\?q=Costco%20Gas%2C%202500%20GEER/);
    });

    test('formatAddress title-cases capitals but keeps state codes and compass points', () => {
        assert.equal(formatAddress('2207 W COMMONWEALTH AVE, ALHAMBRA, CA 91803-1302'),
            '2207 W Commonwealth Ave, Alhambra, CA 91803-1302');
        assert.equal(formatAddress('100 4TH ST NE, MIAMI, FL 33101'), '100 4th St NE, Miami, FL 33101');
        assert.equal(formatAddress('Already Mixed, Case'), 'Already Mixed, Case');
        assert.equal(formatAddress(null), '');
    });

    test('escapeHtml escapes markup characters', () => {
        assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`),
            '&lt;a href=&quot;x&quot; onclick=&#039;y&#039;&gt;&amp;&lt;/a&gt;');
        assert.equal(escapeHtml(null), '');
        assert.equal(escapeHtml(0), '0');
    });

    test('loadJsonPref falls back when storage is unavailable', () => {
        assert.deepEqual(loadJsonPref('favorites', []), []);
    });
});

// The iOS app has the same cases in ios/CostcoGasKit (FillUpTests).
describe('fill-up cost and best value along a route', () => {
    // Stations along a route; `distance` is miles off the route, as the Route tab sets it.
    const onRoute = store({ city: 'OnRoute', regVal: 4.50, distance: 0 });
    const offRoute = store({ city: 'OffRoute', regVal: 4.30, distance: 2 });
    const farOff = store({ city: 'FarOff', regVal: 4.29, distance: 20 });
    const noDiesel = store({ city: 'NoDiesel', regVal: 4.00, distance: 1 });
    const opts = { gallons: 12, mpg: 25 };

    test('a fill-up costs the price times your usual gallons', () => {
        assert.equal(fillCost(4.5, 12).toFixed(2), '54.00');
    });

    test('stops are ranked by fill-up plus the detour off the route and back', () => {
        const stops = routeStopCosts([onRoute, offRoute, farOff], 'regular', opts);
        assert.deepEqual(stops.map(s => s.store.city), ['OffRoute', 'OnRoute', 'FarOff']);
        const off = stops[0];
        assert.equal(off.fillCost.toFixed(2), (4.30 * 12).toFixed(2));
        assert.ok(Math.abs(off.detourMiles - 2 * 2 * ROAD_FACTOR) < 1e-9);
        assert.ok(Math.abs(off.detourCost - (2 * 2 * ROAD_FACTOR / 25) * 4.30) < 1e-9);
        assert.ok(Math.abs(off.total - (off.fillCost + off.detourCost)) < 1e-9);
        // On the route there's no detour.
        assert.equal(stops[1].detourCost, 0);
        // The cheapest price isn't the best value when the detour costs more than it saves.
        assert.equal(stops[2].store.city, 'FarOff');
    });

    test('the best value is marked, and the rest say how much more they cost', () => {
        const stops = routeStopCosts([onRoute, offRoute, farOff], 'regular', opts);
        assert.equal(stops[0].isBest, true);
        assert.equal(stops[0].extraVsBest, 0);
        assert.equal(stops[1].isBest, false);
        assert.ok(Math.abs(stops[1].extraVsBest - (stops[1].total - stops[0].total)) < 1e-9);
        const twin = store({ city: 'Twin', regVal: 4.30, distance: 2 });
        assert.equal(routeStopCosts([offRoute, twin], 'regular', opts)[1].isBest, true);
    });

    test('stations without the grade are left out', () => {
        assert.deepEqual(routeStopCosts([noDiesel], 'diesel', opts), []);
        assert.equal(routeStopCosts([noDiesel, store({ city: 'D', dieselVal: 5, distance: 0 })], 'diesel', opts).length, 1);
    });

    test('car settings fall back when empty, unreadable or out of range', () => {
        assert.equal(readCarSetting('12.5', GALLON_LIMITS, 12), 12.5);
        assert.equal(readCarSetting('', GALLON_LIMITS, 12), 12);
        assert.equal(readCarSetting(null, GALLON_LIMITS, 12), 12);
        assert.equal(readCarSetting('abc', GALLON_LIMITS, 12), 12);
        assert.equal(readCarSetting('0', GALLON_LIMITS, 12), 12);
        assert.equal(readCarSetting('500', GALLON_LIMITS, 12), 12);
    });
});
