const normalizeIdentifier = (value) => String(value ?? '').trim().replace(/^0+(?=\d)/, '');
// Minute precision: DTR edits are saved as HH:MM:00 while the device records seconds.
const minuteKey = (timestamp) => String(timestamp).trim().slice(0, 16);

// Per date: skip if the device has nothing new; add new device punches when every saved
// punch is also on the device; leave the day alone if it has punches the device lacks
// (manual DTR edits), so corrections are never overwritten.
function importMissingDays(db, { pin, registryNumber, staffNoOnDev, newPunches = [] }) {
  const identifiers = new Set([pin, registryNumber, staffNoOnDev].map(normalizeIdentifier).filter(Boolean));
  let inserted = 0;
  let skipped = 0;
  let updatedDays = 0;
  let preservedDays = 0;
  db.run('BEGIN TRANSACTION');
  try {
    const incomingByDay = new Map();
    for (const punch of newPunches) {
      const timestamp = String(punch.timestamp || '').trim();
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
        throw new Error('Invalid attendance timestamp.');
      }
      const day = timestamp.slice(0, 10);
      if (!incomingByDay.has(day)) incomingByDay.set(day, []);
      incomingByDay.get(day).push({ timestamp, rawTime: punch.rawTime || '' });
    }

    const existingByDay = new Map();
    const existing = db.exec('SELECT pin, staffNoOnDev, timestamp FROM punches')[0]?.values || [];
    for (const [storedPin, storedStaff, timestamp] of existing) {
      if (identifiers.has(normalizeIdentifier(storedPin)) || identifiers.has(normalizeIdentifier(storedStaff))) {
        const day = String(timestamp).slice(0, 10);
        if (!existingByDay.has(day)) existingByDay.set(day, new Set());
        existingByDay.get(day).add(minuteKey(timestamp));
      }
    }

    const stmt = db.prepare('INSERT INTO punches (pin, staffNoOnDev, timestamp, rawTime) VALUES (?, ?, ?, ?)');
    try {
      for (const [day, punches] of incomingByDay) {
        const saved = existingByDay.get(day) || new Set();
        const deviceMinutes = new Set(punches.map((p) => minuteKey(p.timestamp)));
        if ([...saved].some((m) => !deviceMinutes.has(m))) {
          skipped += punches.length;
          preservedDays++;
          continue;
        }
        let added = 0;
        for (const punch of punches) {
          const key = minuteKey(punch.timestamp);
          if (saved.has(key)) {
            skipped++;
            continue;
          }
          stmt.run([pin, staffNoOnDev || pin, punch.timestamp, punch.rawTime]);
          saved.add(key);
          added++;
        }
        inserted += added;
        if (added > 0 && existingByDay.has(day)) updatedDays++;
      }
    } finally {
      stmt.free();
    }
    db.run('COMMIT');
    return { success: true, inserted, skipped, updatedDays, preservedDays };
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

module.exports = { importMissingDays };
