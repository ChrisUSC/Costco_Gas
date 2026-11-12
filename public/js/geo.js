// --- Distance and route-corridor geometry ---

export function getDistanceMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function distanceToSegmentMiles(lat, lng, lat1, lng1, lat2, lng2) {
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

export function minDistanceToRouteMiles(lat, lng, routeCoords) {
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

export function getRouteBoundsPadded(routeCoords, bufferMiles) {
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
