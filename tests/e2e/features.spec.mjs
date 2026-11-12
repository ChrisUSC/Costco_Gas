import { test, expect, CHEAPEST, isPhone, openListOnPhone, storeLatLng } from './fixtures.mjs';

const cards = (page) => page.locator('#sidebarContent .store-card');

test.describe('Nearby with location access already allowed', () => {
    const [lat, lng] = storeLatLng('CA', 'Turlock');
    test.use({ permissions: ['geolocation'], geolocation: { latitude: lat, longitude: lng } });

    test('lists the cheapest stations near you, with distances', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('.leaderboard-header')).toHaveText('Cheapest Regular within 50 mi');
        await expect(cards(page).first()).toHaveAttribute('data-city', 'Turlock');
        await expect(cards(page).first().locator('.distance-badge')).toHaveText(/^0\.\d mi$/);
    });

    test('sorting by distance and changing the radius re-render the list', async ({ page }, testInfo) => {
        await page.goto('/');
        await openListOnPhone(page, testInfo);
        await page.locator('#nearbySortSelect').selectOption('distance');
        await expect(page.locator('.leaderboard-header')).toHaveText(/^Closest stations/);
        await page.locator('#nearbyRadiusSelect').selectOption('5');
        await expect(page.locator('.leaderboard-header')).toContainText('within 5 mi');
        await expect(cards(page)).toHaveCount(1);
    });
});

test.describe('Route', () => {
    const turlock = storeLatLng('CA', 'Turlock');
    const tracy = storeLatLng('CA', 'Tracy');
    test.use({
        places: {
            'Start Town': { lat: turlock[0], lng: turlock[1] },
            'End Town': { lat: tracy[0], lng: tracy[1] },
        },
        drivingRoute: { points: [turlock, tracy] },
    });

    test('finds the cheapest stations along a route and can save it', async ({ page }, testInfo) => {
        await page.goto('/?tab=route');
        await openListOnPhone(page, testInfo);
        await page.locator('#routeOrigin').fill('Start Town');
        await page.locator('#routeDestination').fill('End Town');
        await page.locator('[data-action="route-find"]').click();

        await expect(page.locator('.route-summary')).toHaveText(/^40 mi route · \d+ stations? found$/);
        await expect(page.locator('#routeResultsContainer .store-card').first()).toHaveAttribute('data-city', 'Turlock');
        await expect(page.locator('#routeResultsContainer .store-card').filter({ hasText: 'Tracy' })).toHaveCount(1);
        // Only the route's stations are left on the map.
        const pins = await page.locator('#map .leaflet-marker-icon').count();
        expect(pins).toBeLessThan(10);

        await page.locator('[data-action="route-save"]').click();
        await page.locator('#tab-favorites').click();
        await expect(page.locator('.route-card')).toContainText('Start Town');

        // Leaving the Route tab puts every station back on the map.
        await expect.poll(() => page.locator('#map .leaflet-marker-icon, #map .station-cluster').count()).toBeGreaterThan(pins);
    });
});

test.describe('Favorites', () => {
    test('starring a station lists it under Favorites, and it stays after a reload', async ({ page }, testInfo) => {
        await page.goto('/?tab=lowest&state=CA');
        await openListOnPhone(page, testInfo);
        await cards(page).first().locator('[data-action="toggle-favorite"]').click();
        await page.locator('#tab-favorites').click();
        await expect(cards(page)).toHaveCount(1);
        await expect(cards(page).first()).toHaveAttribute('data-city', CHEAPEST.CA);

        await page.reload();
        await page.locator('#tab-favorites').click();
        await expect(cards(page).first()).toHaveAttribute('data-city', CHEAPEST.CA);
    });
});

test.describe('Offline', () => {
    test('losing the connection switches to saved prices; reconnecting refreshes them', async ({ page, context }) => {
        await page.goto('/?tab=route');
        await expect(page.locator('#lastUpdated')).toHaveText(/min ago$/);

        await context.setOffline(true);
        await expect(page.locator('#lastUpdated')).toHaveText(/^Offline · prices from /);
        await expect(page.locator('body')).toHaveClass(/is-offline/);
        await expect(page.locator('#tab-route')).toBeHidden();
        await expect(page.locator('#tab-nearby')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#searchInput')).toHaveAttribute('placeholder', 'Search stations');

        await context.setOffline(false);
        await expect(page.locator('#lastUpdated')).toHaveText(/min ago$/);
        await expect(page.locator('body')).not.toHaveClass(/is-offline/);
        await expect(page.locator('#tab-route')).toBeVisible();
    });
});

test.describe('Back button and keyboard', () => {
    test('Back closes the price history, then the station details', async ({ page }, testInfo) => {
        await page.goto('/?tab=lowest&state=CA');
        await openListOnPhone(page, testInfo);
        await cards(page).first().click(); // opens the station (popup, or the sheet card)
        await expect(page).toHaveURL(/store=CA_Turlock/);

        const details = page.locator('.leaflet-popup-content, #sheetDetailContent, #mobileStoreSheetContent').filter({ hasText: 'Turlock' });
        await details.locator('[data-action="history"]').first().click();
        await expect(page.locator('#chartModal')).toBeVisible();

        await page.goBack();
        await expect(page.locator('#chartModal')).toBeHidden();
        if (isPhone(testInfo)) {
            await expect(page.locator('#sheetDetail')).toBeVisible();
            await page.goBack();
            await expect(page.locator('#sheetDetail')).toBeHidden();
        }
    });

    test('Escape closes settings and arrow keys move between tabs', async ({ page }) => {
        await page.goto('/');
        await page.locator('#settingsBtn').click();
        await expect(page.locator('#settingsModal')).toHaveClass(/active/);
        await page.keyboard.press('Escape');
        await expect(page.locator('#settingsModal')).not.toHaveClass(/active/);

        await page.locator('#tab-nearby').focus();
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('#tab-lowest')).toBeFocused();
        await expect(page.locator('#tab-lowest')).toHaveAttribute('aria-selected', 'true');
    });

    test('dark mode can be switched on (header button, or Settings on phones)', async ({ page }, testInfo) => {
        await page.goto('/');
        if (isPhone(testInfo)) {
            await page.locator('#settingsBtn').click();
            await page.locator('#settingsForm label', { hasText: 'Dark' }).click();
        } else {
            await page.locator('#themeToggle').click();
            await expect(page.locator('#themeToggle')).toHaveAttribute('aria-pressed', 'true');
        }
        await expect(page.locator('body')).toHaveClass(/dark-mode/);
    });
});
