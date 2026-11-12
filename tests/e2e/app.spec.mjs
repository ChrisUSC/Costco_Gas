import { test, expect, CHEAPEST, DIESEL_CITY, openListOnPhone } from './fixtures.mjs';

const lastUpdated = (page) => page.locator('#lastUpdated');
const cards = (page) => page.locator('#sidebarContent .store-card');

test.describe('loading prices', () => {
    test('loads the CDN libraries (integrity checks pass) and draws the map', async ({ page }) => {
        await page.goto('/');
        await expect(lastUpdated(page)).toHaveText(/Updated \d+ min ago/);
        expect(await page.evaluate(() => Boolean(window.L && window.L.markerClusterGroup && window.Chart))).toBe(true);
        await expect(page.locator('#map .leaflet-marker-icon').first()).toBeVisible();
        expect(page.errors.filter((e) => /integrity|Failed to find a valid digest/i.test(e))).toEqual([]);
    });

    test('fresh prices are not flagged as out of date', async ({ page }) => {
        await page.goto('/');
        await expect(lastUpdated(page)).toHaveText(/min ago$/);
        await expect(lastUpdated(page)).not.toHaveClass(/is-stale/);
    });

    test.describe('when the scraper has not updated for hours', () => {
        test.use({ latest: { ageMinutes: 6 * 60 } });

        test('the label turns amber and says the prices may be out of date', async ({ page }) => {
            await page.goto('/');
            await expect(lastUpdated(page)).toHaveText('Updated 6 hr ago · may be out of date');
            await expect(lastUpdated(page)).toHaveClass(/is-stale/);
            await expect(lastUpdated(page)).toHaveAttribute('title', /normally update every hour/);
        });
    });

    test.describe('when the price snapshot fails to load', () => {
        test.use({ latest: { status: 500 } });

        test('shows an error with a retry button', async ({ page }) => {
            await page.goto('/');
            await expect(lastUpdated(page)).toHaveText("Couldn't load prices");
            await expect(page.getByRole('heading', { name: "Couldn't load gas prices" })).toBeVisible();
            await expect(page.locator('[data-action="retry-load"]')).toBeVisible();
        });
    });
});

test.describe('station lists', () => {
    test('State lowest ranks the cheapest station first', async ({ page }) => {
        await page.goto('/?tab=lowest&state=CA');
        await expect(page.locator('.leaderboard-header')).toHaveText('Cheapest Regular in CA');
        const first = cards(page).first();
        await expect(first).toHaveAttribute('data-city', CHEAPEST.CA);
        await expect(first.locator('.card-price-val')).toHaveText('$4.00');
        // 72-hour trend: 4 cents cheaper than the baseline.
        await expect(first.locator('.card-price .trend-down')).toContainText('4¢');
    });

    test('switching state in the leaderboard updates the list and the URL', async ({ page }, testInfo) => {
        await page.goto('/?tab=lowest&state=CA');
        await openListOnPhone(page, testInfo);
        await page.locator('#stateLeaderboardSelect').selectOption('TX');
        await expect(cards(page).first()).toHaveAttribute('data-city', CHEAPEST.TX);
        await expect(page).toHaveURL(/state=TX/);
    });

    test('Diesel shows only stations that sell diesel', async ({ page }) => {
        await page.goto('/?tab=lowest&state=CA');
        await page.locator('#btn-diesel').click();
        await expect(page.locator('.leaderboard-header')).toHaveText('Cheapest Diesel in CA');
        await expect(cards(page)).toHaveCount(1);
        await expect(cards(page).first()).toHaveAttribute('data-city', DIESEL_CITY);
        await expect(page).toHaveURL(/grade=diesel/);
    });

    test('search suggests matching stations', async ({ page }) => {
        await page.goto('/');
        await page.locator('#searchInput').fill('Turlock');
        await expect(page.locator('#autocompleteDropdown')).toContainText('Turlock');
    });
});

test.describe('station details', () => {
    test('a shared ?store= link opens that station', async ({ page }) => {
        await page.goto('/?store=CA_Turlock');
        const details = page.locator('.leaflet-popup-content, #sheetDetailContent, #mobileStoreSheetContent').filter({ hasText: 'Turlock' });
        await expect(details.first()).toBeVisible();
    });

    test('the price history chart opens from a station card', async ({ page }, testInfo) => {
        await page.goto('/?tab=lowest&state=CA');
        await openListOnPhone(page, testInfo);
        await cards(page).first().locator('[data-action="history"]').click();
        await expect(page.locator('#chartModal')).toBeVisible();
        await expect(page.locator('#chartTitle')).toContainText('Turlock');
        await expect(page.locator('#priceChart')).toBeVisible();
        await expect(page.locator('#historyRangeControls')).toBeVisible();
    });

    test('settings are saved and change the directions app', async ({ page }) => {
        await page.goto('/?tab=lowest&state=CA');
        await page.locator('#settingsBtn').click();
        await page.locator('#settingsForm label', { hasText: 'Waze' }).click();
        await page.locator('[data-action="close-settings"]').click();
        await expect(cards(page).first().locator('.btn-directions')).toHaveAttribute('href', /^https:\/\/waze\.com\//);
        await page.reload();
        await expect(cards(page).first().locator('.btn-directions')).toHaveAttribute('href', /^https:\/\/waze\.com\//);
    });
});
