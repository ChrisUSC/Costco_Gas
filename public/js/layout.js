// --- Layout tiers: which of the phone, tablet and desktop layouts is showing ---


// Phones (<= this width) show the station list as a draggable bottom sheet and station
// details inside it. Keep in sync with the media queries in styles.css.
const PHONE_MAX_WIDTH = 599;

// Layout tiers (keep in sync with the media queries in styles.css):
//   phone   <= 599px   map + draggable bottom sheet for the list
//   tablet  600-1099px sidebar + map, store details in a sheet over the map
//   desktop >= 1100px  sidebar + map, store details in the Leaflet popup
const SHEET_MAX_WIDTH = 1099;

export function isPhoneViewport() {
    return window.innerWidth <= PHONE_MAX_WIDTH;
}

// Phones and tablets show store details in the bottom sheet instead of a map popup.
export function isMobileViewport() {
    return window.innerWidth <= SHEET_MAX_WIDTH;
}

export function isTabletPortrait() {
    return window.innerWidth > PHONE_MAX_WIDTH && window.innerWidth <= SHEET_MAX_WIDTH
        && window.matchMedia?.('(orientation: portrait)').matches;
}
