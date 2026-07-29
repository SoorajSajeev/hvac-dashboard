export const REGIONS = {
  Mumbai: {
    name: 'Mumbai',
    units: [
      { buildingId: '1', name: 'Powai Campus' },
      { buildingId: '2', name: 'Banyan Park' },
    ],
  },
  Kerala: {
    name: 'Kerala',
    units: [
      { buildingId: '3', name: 'Peepul Park' },
      { buildingId: '4', name: 'DC' },
    ],
  },
};

// Reverse lookup: given a building_id, find its region + display name
export function getUnitInfo(buildingId) {
  const id = String(buildingId);
  for (const regionKey of Object.keys(REGIONS)) {
    const region = REGIONS[regionKey];
    const unit = region.units.find((u) => u.buildingId === id);
    if (unit) return { region: regionKey, name: unit.name };
  }
  return { region: 'Unassigned', name: `Unit #${buildingId}` };
}