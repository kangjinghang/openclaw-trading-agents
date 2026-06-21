"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectCandidates = selectCandidates;
function selectCandidates(scan, holdings, opts) {
    const map = new Map();
    const top = scan.top_picks.slice(0, opts.topN);
    for (const p of top) {
        map.set(p.ticker, {
            ticker: p.ticker,
            name: p.name,
            is_held: false,
            current_weight: 0,
            days_held: 0,
            locked: false,
            ranker_score: p.score,
        });
    }
    for (const pos of holdings.positions) {
        const daysHeld = computeDaysHeld(pos.entry_date, opts.currentDate);
        const locked = computeLocked(pos.entry_date, opts.currentDate, opts.antiChurnDays);
        const existing = map.get(pos.ticker);
        if (existing) {
            existing.is_held = true;
            existing.current_weight = pos.weight;
            existing.days_held = daysHeld;
            existing.locked = locked;
        }
        else {
            map.set(pos.ticker, {
                ticker: pos.ticker,
                name: pos.name,
                is_held: true,
                current_weight: pos.weight,
                days_held: daysHeld,
                locked: locked,
            });
        }
    }
    return Array.from(map.values());
}
function computeDaysHeld(entryDate, currentDate) {
    const entry = new Date(entryDate + "T00:00:00+08:00").getTime();
    const cur = new Date(currentDate + "T00:00:00+08:00").getTime();
    if (isNaN(entry) || isNaN(cur))
        return 0;
    return Math.floor((cur - entry) / (24 * 60 * 60 * 1000));
}
function computeLocked(entryDate, currentDate, antiChurnDays) {
    const daysHeld = computeDaysHeld(entryDate, currentDate);
    return daysHeld < antiChurnDays;
}
//# sourceMappingURL=candidate-selector.js.map