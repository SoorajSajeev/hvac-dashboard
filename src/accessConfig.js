export const REGION_CODES = {
  Kerala: '345',
  Mumbai: '455',
};

export const UNIT_CODES = {
  '1': '787',
  '2': '888',
  '3': '676',
  '4': '777',
};

export const ROLES = ['manager', 'admin', 'engineer'];

// Validates the code entered against the selected scope, based on role
export function validateAccessCode(role, scopeValue, code) {
  if (role === 'admin') return true; // admin doesn't need a code
  if (role === 'manager') return REGION_CODES[scopeValue] === code;
  if (role === 'engineer') return UNIT_CODES[scopeValue] === code;
  return false;
}

// Given a user's role + scope, returns which building_ids they're allowed to see
export function getAllowedBuildingIds(role, scopeValue, REGIONS) {
  if (role === 'admin') {
    return Object.values(REGIONS).flatMap((r) => r.units.map((u) => u.buildingId));
  }
  if (role === 'manager') {
    return REGIONS[scopeValue]?.units.map((u) => u.buildingId) || [];
  }
  if (role === 'engineer') {
    return [scopeValue];
  }
  return [];
}

// Physical placement of each node type within a real AHU, for display purposes
export const NODE_PLACEMENT = {
  motor: 'Mounted on the drive-side motor frame, inside the blower compartment',
  belt: 'Belt/pulley assembly between motor shaft and blower shaft',
  filter: 'Filter bank, upstream of the blower section (return air side)',
};