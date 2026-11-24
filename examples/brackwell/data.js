// Brackwell's sample data: one made-up field services company ("Northgate
// Mechanical") running on Brackwell in a made-up city (Port Alder). Every
// name, address, number and amount is invented; a seeded generator keeps
// every build identical.

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20261122)
const pick = (list) => list[Math.floor(rand() * list.length)]
const between = (min, max) => Math.round(min + rand() * (max - min))

export const COMPANY = 'Northgate Mechanical'
export const CITY = 'Port Alder'
export const ME = { name: 'Robin Ash', role: 'Operations lead', email: 'robin@northgate.example' }

export const TECHS = [
  { name: 'Dana Whitlock', trade: 'HVAC', crew: 'North crew', state: 'On a job', jobs: 5, util: 92, rating: 4.9 },
  { name: 'Marcus Okafor', trade: 'Electrical', crew: 'North crew', state: 'En route', jobs: 4, util: 84, rating: 4.8 },
  { name: 'Lena Varga', trade: 'Plumbing', crew: 'River crew', state: 'On a job', jobs: 6, util: 97, rating: 4.9 },
  { name: 'Theo Brandt', trade: 'HVAC', crew: 'River crew', state: 'Online', jobs: 3, util: 71, rating: 4.6 },
  { name: 'Ines Carvalho', trade: 'Refrigeration', crew: 'Harbor crew', state: 'On a job', jobs: 4, util: 88, rating: 4.7 },
  { name: 'Kofi Mensah', trade: 'Electrical', crew: 'Harbor crew', state: 'Offline', jobs: 0, util: 0, rating: 4.8 },
  { name: 'Priya Raman', trade: 'Fire safety', crew: 'North crew', state: 'Online', jobs: 2, util: 63, rating: 5.0 },
  { name: 'Owen Gallagher', trade: 'Plumbing', crew: 'River crew', state: 'En route', jobs: 5, util: 90, rating: 4.5 },
  { name: 'Sofia Lindqvist', trade: 'HVAC', crew: 'Harbor crew', state: 'On a job', jobs: 4, util: 86, rating: 4.8 },
  { name: 'Ravi Deshpande', trade: 'Controls', crew: 'North crew', state: 'Online', jobs: 3, util: 74, rating: 4.7 },
  { name: 'Hana Sato', trade: 'Electrical', crew: 'River crew', state: 'On a job', jobs: 5, util: 91, rating: 4.9 },
  { name: 'Felix Moreau', trade: 'General', crew: 'Harbor crew', state: 'Online', jobs: 2, util: 58, rating: 4.4 },
]

export const CUSTOMERS = [
  { name: 'Crestline Dental Group', type: 'Healthcare', sites: 4, open: 3, value: 48200, contact: 'Amara Bell' },
  { name: 'Harborview Apartments', type: 'Residential', sites: 9, open: 7, value: 126400, contact: 'Jonah Pierce' },
  { name: 'Pine & Copper Bistro', type: 'Hospitality', sites: 2, open: 1, value: 18950, contact: 'Celia Moran' },
  { name: 'Alder County Library', type: 'Public', sites: 6, open: 2, value: 64300, contact: 'Walt Ferris' },
  { name: 'Brightwater Fitness', type: 'Retail', sites: 3, open: 4, value: 37800, contact: 'Nadia Quinn' },
  { name: 'Ridgeway Logistics Park', type: 'Industrial', sites: 5, open: 6, value: 212900, contact: 'Gus Halvorsen' },
  { name: 'Saltmarsh Elementary', type: 'Education', sites: 1, open: 2, value: 22100, contact: 'Ruth Akande' },
  { name: 'Larkspur Hotel', type: 'Hospitality', sites: 1, open: 3, value: 71250, contact: 'Ivo Petrov' },
  { name: 'Meridian Office Tower', type: 'Commercial', sites: 2, open: 5, value: 154600, contact: 'Kim Takahashi' },
  { name: 'Foxglove Senior Living', type: 'Healthcare', sites: 3, open: 2, value: 59900, contact: 'Lorna Fitch' },
  { name: 'Tidewater Brewing Co.', type: 'Industrial', sites: 2, open: 1, value: 28400, contact: 'Ben Okoye' },
  { name: 'Quarry Lane Clinic', type: 'Healthcare', sites: 1, open: 0, value: 9800, contact: 'Esme Duarte' },
]

const STREETS = [
  'Wharf St',
  'Alder Ave',
  'Copperleaf Rd',
  'Marsh Ln',
  'Beacon Way',
  'Tannery Row',
  'Ferry Rd',
  'Juniper Ct',
  'Signal Hill Dr',
  'Kiln St',
]
export const address = () => `${between(12, 2890)} ${pick(STREETS)}, ${CITY}`

const JOBS = [
  ['Rooftop unit not cooling', 'HVAC'],
  ['Quarterly PM: boilers', 'HVAC'],
  ['Walk-in freezer alarm', 'Refrigeration'],
  ['Replace water heater', 'Plumbing'],
  ['Panel upgrade, east wing', 'Electrical'],
  ['Fire damper inspection', 'Fire safety'],
  ['Leak under sink, unit 4B', 'Plumbing'],
  ['Thermostat offline, floor 3', 'Controls'],
  ['Emergency lighting test', 'Electrical'],
  ['Ice machine not draining', 'Refrigeration'],
  ['Annual backflow test', 'Plumbing'],
  ['Exhaust fan noisy', 'HVAC'],
  ['Install EV charger', 'Electrical'],
  ['Chiller startup', 'HVAC'],
  ['Grease trap service', 'Plumbing'],
  ['Replace ballast, lobby', 'Electrical'],
]
const STATES = ['New', 'Scheduled', 'En route', 'In progress', 'In progress', 'Completed', 'Scheduled', 'On hold', 'Completed', 'Invoiced']

export const WORK_ORDERS = Array.from({ length: 48 }, (_, i) => {
  const [title, trade] = JOBS[i % JOBS.length]
  const customer = CUSTOMERS[(i * 5) % CUSTOMERS.length]
  const state = STATES[(i * 3) % STATES.length]
  const tech = state === 'New' ? null : TECHS.find((t) => t.trade === trade) || TECHS[i % TECHS.length]
  return {
    id: `WO-${4820 + i}`,
    title,
    trade,
    customer: customer.name,
    site: `${customer.name.split(' ')[0]} ${pick(['Main', 'North', 'East', 'Annex', 'Tower', 'Unit 2'])}`,
    state,
    prio: [1, 2, 1, 3, 1, 2][i % 6],
    tech: tech?.name || null,
    due: `Nov ${(i % 9) + 23}`,
    window: `${pick(['8:00', '9:30', '10:00', '13:00', '14:30'])}`,
    value: between(180, 4200),
  }
})

export const PARTS = [
  ['FLT-2025', 'Pleated filter 20x25x2 MERV 13', 'Filters', 46, 120, 8.4],
  ['CAP-4505', 'Run capacitor 45/5 MFD', 'Electrical', 7, 24, 18.9],
  ['CNT-30A', 'Contactor 30A 2-pole', 'Electrical', 14, 20, 22.5],
  ['BLT-A42', 'V-belt A42', 'Drives', 3, 15, 11.2],
  ['TXV-R410', 'TXV valve R-410A 3 ton', 'Refrigeration', 4, 6, 142.0],
  ['WH-50G', 'Water heater 50 gal gas', 'Plumbing', 2, 2, 1180.0],
  ['PEX-34', 'PEX tubing 3/4 in, 100 ft', 'Plumbing', 11, 10, 64.0],
  ['TST-PRO', 'Smart thermostat, commercial', 'Controls', 9, 12, 219.0],
  ['BAL-T8', 'T8 ballast, 4 lamp', 'Electrical', 0, 10, 34.5],
  ['MTR-ECM', 'ECM blower motor 1/2 HP', 'Motors', 5, 4, 386.0],
  ['GSK-WI', 'Walk-in door gasket', 'Refrigeration', 6, 6, 58.0],
  ['BFP-1', 'Backflow repair kit 1 in', 'Plumbing', 8, 10, 41.0],
  ['CND-24', 'Condensate pump 24 V', 'HVAC', 12, 8, 96.0],
  ['FUS-30', 'Fuse 30A time delay (10 pk)', 'Electrical', 21, 10, 27.0],
].map(([sku, name, cat, stock, min, cost]) => ({
  sku,
  name,
  cat,
  stock,
  min,
  cost,
  state: stock === 0 ? 'Out of stock' : stock < min ? 'Low stock' : 'In stock',
}))

export const INVOICES = Array.from({ length: 22 }, (_, i) => {
  const customer = CUSTOMERS[(i * 7) % CUSTOMERS.length]
  const state = ['Paid', 'Sent', 'Overdue', 'Paid', 'Draft', 'Partially paid', 'Paid', 'Sent'][i % 8]
  return {
    id: `INV-${20614 + i}`,
    customer: customer.name,
    wo: `WO-${4790 + i}`,
    issued: `Nov ${Math.max(1, 21 - i)}`,
    due: `Dec ${Math.max(1, 21 - i)}`,
    amount: between(240, 9800) + 0.5 * (i % 2),
    state,
  }
})

export const PROJECTS = [
  {
    name: 'Meridian Tower chiller retrofit',
    customer: 'Meridian Office Tower',
    state: 'On track',
    pct: 64,
    budget: 182000,
    spent: 109400,
    due: 'Feb 14',
    lead: 'Sofia Lindqvist',
  },
  {
    name: 'Harborview boiler replacement',
    customer: 'Harborview Apartments',
    state: 'At risk',
    pct: 41,
    budget: 96500,
    spent: 58100,
    due: 'Jan 9',
    lead: 'Theo Brandt',
  },
  {
    name: 'Library LED lighting upgrade',
    customer: 'Alder County Library',
    state: 'On track',
    pct: 82,
    budget: 54200,
    spent: 41900,
    due: 'Dec 19',
    lead: 'Hana Sato',
  },
  {
    name: 'Ridgeway dock door heaters',
    customer: 'Ridgeway Logistics Park',
    state: 'Planning',
    pct: 8,
    budget: 71800,
    spent: 3200,
    due: 'Mar 30',
    lead: 'Marcus Okafor',
  },
  {
    name: 'Larkspur kitchen exhaust',
    customer: 'Larkspur Hotel',
    state: 'Off track',
    pct: 55,
    budget: 38900,
    spent: 36100,
    due: 'Dec 5',
    lead: 'Dana Whitlock',
  },
  {
    name: 'Foxglove nurse call wiring',
    customer: 'Foxglove Senior Living',
    state: 'On track',
    pct: 30,
    budget: 61400,
    spent: 17200,
    due: 'Feb 2',
    lead: 'Ravi Deshpande',
  },
]

export const PURCHASE_ORDERS = [
  { id: 'PO-1182', vendor: 'Coastline HVAC Supply', items: 6, total: 2384.5, state: 'Ordered', eta: 'Nov 26' },
  { id: 'PO-1181', vendor: 'Brightline Electric Wholesale', items: 3, total: 612.0, state: 'Received', eta: 'Nov 20' },
  { id: 'PO-1180', vendor: 'Fathom Plumbing Parts', items: 9, total: 4120.75, state: 'Pending', eta: 'Dec 2' },
  { id: 'PO-1179', vendor: 'Coastline HVAC Supply', items: 2, total: 284.0, state: 'Received', eta: 'Nov 17' },
  { id: 'PO-1178', vendor: 'Polar Refrigeration Co.', items: 4, total: 1488.0, state: 'Draft', eta: '--' },
  { id: 'PO-1177', vendor: 'Brightline Electric Wholesale', items: 12, total: 3910.4, state: 'Received', eta: 'Nov 12' },
]

export const MEMBERS = [
  ['Robin Ash', 'robin@northgate.example', 'Owner', 'Active', 'Just now'],
  ['Jo Park', 'jo@northgate.example', 'Admin', 'Active', '12 min ago'],
  ['Mei Lin', 'mei@northgate.example', 'Dispatcher', 'Active', '1 hour ago'],
  ['Sam Ortiz', 'sam@northgate.example', 'Billing', 'Active', 'Yesterday'],
  ['Priya Raman', 'priya.r@northgate.example', 'Technician', 'Active', '3 hours ago'],
  ['Alex Kim', 'alex@northgate.example', 'Viewer', 'Invited', '--'],
  ['Dana Whitlock', 'dana@northgate.example', 'Technician', 'Active', '20 min ago'],
  ['Lee Chan', 'lee@northgate.example', 'Dispatcher', 'Suspended', 'Oct 2'],
]

export const MONTHS = ['Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']
export const REVENUE = [182, 171, 194, 210, 226, 241, 238, 256, 271, 265, 288, 304]
export const REVENUE_LAST = [160, 158, 166, 181, 190, 204, 211, 219, 228, 233, 241, 250]
export const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
