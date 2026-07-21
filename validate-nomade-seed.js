#!/usr/bin/env node
/**
 * Deterministic validator for nomade-menu-seed-v1.json.
 *
 * Run: node validate-nomade-seed.js
 * Exits 0 if every check passes, non-zero (count of failures) otherwise.
 * Prints a PASS/FAIL line per check plus a final summary with exact counts.
 */

const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, 'nomade-menu-seed-v1.json');

const EXPECTED_CATEGORY_COUNT = 16;
const EXPECTED_TOP_LEVEL_ITEM_COUNT = 52;
const EXPECTED_POPUP_PARENTS = {
  purified_water: { nameEn: 'Purified Water', variantCount: 2 },
  house_wine: { nameEn: 'Glass of House Wine', variantCount: 3 },
  gin_tonic: { nameEn: 'Gin & Tonic', variantCount: 2 },
  na_gin_tonic: { nameEn: 'Non Alcoholic Gin & Tonic', variantCount: 2 },
  galipette_na: { nameEn: 'Galipette Non Alcoholic 0.33 L', variantCount: 2 },
};
const EXPECTED_VARIANT_COUNT = 11;
const EXPECTED_WINE_COUNT = 19;
const EXPECTED_TOTAL_KEYS = 82; // 52 top-level records + 11 variants + 19 wines

const THE_TOP_MARKERS = [
  'The TOP', 'The Top', 'THE TOP', 'the-top', 'the_top',
  'Рибай 350г', 'Бефстроганов', 'Стейк тунца', 'Салат с тунцом',
  'Эспада', 'Осьминог малиновый', 'Котлета по-киевски', 'Утиная грудка',
];

const failures = [];
const results = [];

function check(label, ok, detail) {
  results.push({ label, ok, detail });
  if (!ok) failures.push(label + (detail ? ' — ' + detail : ''));
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
let raw;
try {
  raw = fs.readFileSync(SEED_PATH, 'utf8');
} catch (e) {
  console.error('FATAL: could not read ' + SEED_PATH + ': ' + e.message);
  process.exit(1);
}

let seed;
try {
  seed = JSON.parse(raw);
} catch (e) {
  console.error('FATAL: nomade-menu-seed-v1.json is not valid JSON: ' + e.message);
  process.exit(1);
}

const categories = seed.categories || {};
const categoryKeys = Object.keys(categories);
const wines = seed.wines || [];

// ---------------------------------------------------------------------------
// 1. Exactly 16 regular categories
// ---------------------------------------------------------------------------
check('1. Category count === 16', categoryKeys.length === EXPECTED_CATEGORY_COUNT,
  'found ' + categoryKeys.length);

// ---------------------------------------------------------------------------
// 2. Exactly 52 top-level regular menu items (across all categories, incl. group parents)
// ---------------------------------------------------------------------------
const topLevelItems = []; // { catKey, itemId, item }
categoryKeys.forEach(catKey => {
  const items = categories[catKey].items || {};
  Object.entries(items).forEach(([itemId, item]) => {
    topLevelItems.push({ catKey, itemId, item });
  });
});
check('2. Top-level item count === 52', topLevelItems.length === EXPECTED_TOP_LEVEL_ITEM_COUNT,
  'found ' + topLevelItems.length);

// ---------------------------------------------------------------------------
// 3. Exactly 5 popup parent products (isGroup true), matching expected groupKeys/names
// ---------------------------------------------------------------------------
const popupParents = topLevelItems.filter(e => e.item.isGroup === true);
check('3. Popup parent count === 5', popupParents.length === 5, 'found ' + popupParents.length);

const foundGroupKeys = new Set(popupParents.map(e => e.item.groupKey));
const expectedGroupKeys = Object.keys(EXPECTED_POPUP_PARENTS);
const missingGroupKeys = expectedGroupKeys.filter(k => !foundGroupKeys.has(k));
check('3b. All 5 expected popup groupKeys present', missingGroupKeys.length === 0,
  missingGroupKeys.length ? 'missing: ' + missingGroupKeys.join(', ') : '');

expectedGroupKeys.forEach(gk => {
  const entry = popupParents.find(e => e.item.groupKey === gk);
  const expectedName = EXPECTED_POPUP_PARENTS[gk].nameEn;
  check('3c. Popup parent "' + gk + '" nameEn === "' + expectedName + '"',
    !!entry && entry.item.nameEn === expectedName,
    entry ? ('got "' + entry.item.nameEn + '"') : 'parent not found');
});

// ---------------------------------------------------------------------------
// 4. Exactly 11 popup variants, with the exact per-parent breakdown
// ---------------------------------------------------------------------------
let totalVariants = 0;
const variantRecords = []; // { groupKey, variant }
popupParents.forEach(({ item }) => {
  const variants = item.variants || [];
  totalVariants += variants.length;
  variants.forEach(v => variantRecords.push({ groupKey: item.groupKey, variant: v }));
  const expected = EXPECTED_POPUP_PARENTS[item.groupKey];
  if (expected) {
    check('4. Variant count for "' + item.groupKey + '" === ' + expected.variantCount,
      variants.length === expected.variantCount,
      'found ' + variants.length);
  }
});
check('4b. Total variant count === 11', totalVariants === EXPECTED_VARIANT_COUNT,
  'found ' + totalVariants);

// ---------------------------------------------------------------------------
// 5. Exactly 19 bottled wines
// ---------------------------------------------------------------------------
check('5. Wine count === 19', wines.length === EXPECTED_WINE_COUNT, 'found ' + wines.length);

// ---------------------------------------------------------------------------
// 6. Exactly 82 globally unique order-addressable internal keys
//    = 52 top-level item.name values + 11 variant.name values + 19 wine.name values
// ---------------------------------------------------------------------------
const allNames = [];
topLevelItems.forEach(({ item }) => allNames.push(item.name));
variantRecords.forEach(({ variant }) => allNames.push(variant.name));
wines.forEach(w => allNames.push(w.name));

check('6. Total key count === 82 (52 top-level + 11 variants + 19 wines)',
  allNames.length === EXPECTED_TOTAL_KEYS, 'found ' + allNames.length);

// ---------------------------------------------------------------------------
// 7. No duplicate internal IDs (Firebase item keys) or internal names
// ---------------------------------------------------------------------------
const idCounts = {};
topLevelItems.forEach(({ catKey, itemId }) => {
  const k = catKey + '/' + itemId;
  idCounts[k] = (idCounts[k] || 0) + 1;
});
const dupIds = Object.keys(idCounts).filter(k => idCounts[k] > 1);
check('7a. No duplicate category/itemId pairs', dupIds.length === 0,
  dupIds.length ? dupIds.join(', ') : '');

const nameCounts = {};
allNames.forEach(n => { nameCounts[n] = (nameCounts[n] || 0) + 1; });
const dupNames = Object.keys(nameCounts).filter(n => nameCounts[n] > 1);
check('7b. No duplicate internal name values across items+variants+wines',
  dupNames.length === 0, dupNames.length ? dupNames.join(', ') : '');

// ---------------------------------------------------------------------------
// 8. No localized RU/EN visible name used as a Firebase key (itemId) or as an
//    internal `name` value.
// ---------------------------------------------------------------------------
const cyrillicRe = /[Ѐ-ӿ]/;
const localizedAsKey = [];
topLevelItems.forEach(({ catKey, itemId, item }) => {
  if (cyrillicRe.test(itemId)) localizedAsKey.push(catKey + '/' + itemId + ' (itemId)');
  if (item.name && (item.name === item.nameRu || item.name === item.nameEn) && cyrillicRe.test(item.name)) {
    localizedAsKey.push(catKey + '/' + itemId + ' (name="' + item.name + '")');
  }
});
variantRecords.forEach(({ groupKey, variant }) => {
  if (variant.name && cyrillicRe.test(variant.name)) {
    localizedAsKey.push(groupKey + '/variant (name="' + variant.name + '")');
  }
});
wines.forEach(w => {
  if (w.name && cyrillicRe.test(w.name)) localizedAsKey.push('wine (name="' + w.name + '")');
});
check('8. No RU visible name used as internal key/name', localizedAsKey.length === 0,
  localizedAsKey.length ? localizedAsKey.join('; ') : '');

// ---------------------------------------------------------------------------
// 9. Every category has nameRu and nameEn
// ---------------------------------------------------------------------------
const catsMissingNames = categoryKeys.filter(k => !categories[k].nameRu || !categories[k].nameEn);
check('9. Every category has nameRu+nameEn', catsMissingNames.length === 0,
  catsMissingNames.length ? catsMissingNames.join(', ') : '');

// ---------------------------------------------------------------------------
// 10. Every top-level item has stable name, nameRu, nameEn, numeric price
//     (unless it's a popup parent, whose own price lives on its variants)
// ---------------------------------------------------------------------------
const badTopLevel = [];
topLevelItems.forEach(({ catKey, itemId, item }) => {
  if (!item.name || typeof item.name !== 'string') badTopLevel.push(catKey + '/' + itemId + ': missing/invalid name');
  if (!item.nameRu) badTopLevel.push(catKey + '/' + itemId + ': missing nameRu');
  if (!item.nameEn) badTopLevel.push(catKey + '/' + itemId + ': missing nameEn');
  if (!item.isGroup) {
    if (typeof item.price !== 'number' || Number.isNaN(item.price)) {
      badTopLevel.push(catKey + '/' + itemId + ': missing/non-numeric price');
    }
  } else {
    if (item.price !== undefined) badTopLevel.push(catKey + '/' + itemId + ': group parent should not carry its own price');
  }
});
check('10. Every top-level item has name/nameRu/nameEn (+numeric price if not a popup parent)',
  badTopLevel.length === 0, badTopLevel.length ? badTopLevel.join('; ') : '');

// ---------------------------------------------------------------------------
// 11. Every variant has stable name, nameRu(ru)/nameEn(en), numeric price, valid parent
// ---------------------------------------------------------------------------
const badVariants = [];
variantRecords.forEach(({ groupKey, variant }) => {
  if (!variant.name) badVariants.push(groupKey + ': variant missing name');
  if (!variant.ru) badVariants.push(groupKey + ': variant missing ru');
  if (!variant.en) badVariants.push(groupKey + ': variant missing en');
  if (typeof variant.price !== 'number' || Number.isNaN(variant.price)) {
    badVariants.push(groupKey + ': variant "' + variant.name + '" missing/non-numeric price');
  }
  if (!EXPECTED_POPUP_PARENTS[groupKey]) badVariants.push(groupKey + ': not a recognized parent groupKey');
});
check('11. Every variant has name/ru/en/numeric price + valid parent reference',
  badVariants.length === 0, badVariants.length ? badVariants.join('; ') : '');

// ---------------------------------------------------------------------------
// 12. Every wine has stable name, nameRu, nameEn, numeric price, valid menuGroup
// ---------------------------------------------------------------------------
const EXPECTED_BOTTLE_GROUPS = ['easy_start', 'perfect_pairing', 'something_special', 'found_loved', 'deeper_richer', 'something_different'];
const badWines = [];
wines.forEach(w => {
  if (!w.name) badWines.push('wine missing name');
  if (!w.nameRu) badWines.push(w.name + ': missing nameRu');
  if (!w.nameEn) badWines.push(w.name + ': missing nameEn');
  if (typeof w.price !== 'number' || Number.isNaN(w.price)) badWines.push(w.name + ': missing/non-numeric price');
  if (!w.menuGroup || !EXPECTED_BOTTLE_GROUPS.includes(w.menuGroup)) {
    badWines.push(w.name + ': invalid/missing menuGroup "' + w.menuGroup + '"');
  }
});
check('12. Every wine has name/nameRu/nameEn/numeric price + valid menuGroup',
  badWines.length === 0, badWines.length ? badWines.join('; ') : '');

// ---------------------------------------------------------------------------
// 13. Category sortOrder values unique and match requested order (10,20,...,160)
// ---------------------------------------------------------------------------
const EXPECTED_CATEGORY_ORDER = [
  'signature_cocktails', 'classic_cocktails', 'mocktails', 'craft_beer', 'craft_cider',
  'homemade_lemonades', 'organic_soft_drinks', 'nomade_kombucha', 'nomade_water',
  'wine_by_glass', 'fine_with_wine', 'first_things_first', 'warm_starters',
  'catch_and_carve', 'leaf_and_crunch', 'beyond_pasta',
];
const sortOrders = categoryKeys.map(k => categories[k].sortOrder);
const uniqueSortOrders = new Set(sortOrders);
check('13a. Category sortOrder values are unique', uniqueSortOrders.size === categoryKeys.length,
  'found ' + uniqueSortOrders.size + ' unique of ' + categoryKeys.length);

const actualOrder = categoryKeys.slice().sort((a, b) => categories[a].sortOrder - categories[b].sortOrder);
const orderMatches = JSON.stringify(actualOrder) === JSON.stringify(EXPECTED_CATEGORY_ORDER);
check('13b. Category order (by sortOrder) matches the specified sequence exactly',
  orderMatches, orderMatches ? '' : 'got: ' + actualOrder.join(', '));

// Bottle-wine group order: derived from wine appearance order per group (push-key /
// insertion order in the JSON array), each curated group's wines must be contiguous
// in menuGroup-order for the array to reflect the specified sequence.
const wineGroupAppearanceOrder = [];
wines.forEach(w => {
  if (!wineGroupAppearanceOrder.includes(w.menuGroup)) wineGroupAppearanceOrder.push(w.menuGroup);
});
const groupOrderMatches = JSON.stringify(wineGroupAppearanceOrder) === JSON.stringify(EXPECTED_BOTTLE_GROUPS);
check('13c. Bottle-wine group order (by first appearance in wines[]) matches the specified sequence',
  groupOrderMatches, groupOrderMatches ? '' : 'got: ' + wineGroupAppearanceOrder.join(', '));

// ---------------------------------------------------------------------------
// 14. No The Top product names or old seed records exist in the Nomade seed file
// ---------------------------------------------------------------------------
const theTopHits = [];
function scanForTheTop(value, pathLabel) {
  if (typeof value === 'string') {
    THE_TOP_MARKERS.forEach(marker => {
      if (value.includes(marker)) theTopHits.push(pathLabel + ' contains "' + marker + '"');
    });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForTheTop(v, pathLabel + '[' + i + ']'));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => scanForTheTop(v, pathLabel + '.' + k));
  }
}
scanForTheTop(seed, 'seed');
check('14. No The Top product names / old seed records in the seed file', theTopHits.length === 0,
  theTopHits.length ? theTopHits.join('; ') : '');

// ---------------------------------------------------------------------------
// 15. No conflicting legacy wine prices present (the one-page overview prices)
// ---------------------------------------------------------------------------
// Conflicting legacy (one-page overview) prices, keyed by canonical wine name,
// that must NOT appear anywhere in the seeded wine price list.
const LEGACY_CONFLICTING_PRICES = {
  'wine_sparkling': [25],           // overview had a different Sparkling Wine price
  'wine_white_madeira': [25],
  'wine_sauvignon_blanc_lisbon': [25],
  'wine_rose_madeira': [25],
  'wine_red_madeira': [25],
  'wine_green': [26],
  'wine_pixie_branco': [32],
  'wine_pixie_tinto': [33],
};
const legacyHits = [];
wines.forEach(w => {
  const legacyPrices = LEGACY_CONFLICTING_PRICES[w.name];
  if (legacyPrices && legacyPrices.includes(w.price)) {
    legacyHits.push(w.name + ' price ' + w.price + ' matches a known-conflicting legacy price');
  }
});
// Canonical prices from Part A of the spec — authoritative check that every wine's
// seeded price matches the later two-page bottle list, not any other value.
const CANONICAL_PRICES = {
  wine_natcool_branco_1l: 29, wine_natcool_tinto_1l: 29, wine_sparkling: 28,
  wine_white_madeira: 28, wine_sauvignon_blanc_lisbon: 28, wine_rose_madeira: 28,
  wine_red_madeira: 28, wine_green: 30, wine_casters_liebart: 55,
  wine_pixie_branco: 35, wine_pixie_tinto: 36, wine_reisling_tejo: 35,
  wine_chardonnay_douro: 30, wine_cabernet_sauvignon_lisbon: 35, wine_pinot_noir_tejo: 35,
  wine_pet_nat_white: 32, wine_pet_nat_rose: 32, wine_pet_nat_light_red: 32,
  wine_orange_verde_douro: 34,
};
const priceMismatches = [];
wines.forEach(w => {
  const expected = CANONICAL_PRICES[w.name];
  if (expected === undefined) { priceMismatches.push(w.name + ': not a recognized canonical wine'); return; }
  if (w.price !== expected) priceMismatches.push(w.name + ': expected €' + expected + ', got €' + w.price);
});
check('15a. No known-conflicting legacy wine prices present', legacyHits.length === 0,
  legacyHits.length ? legacyHits.join('; ') : '');
check('15b. Every wine price matches the canonical two-page bottle list exactly',
  priceMismatches.length === 0, priceMismatches.length ? priceMismatches.join('; ') : '');
check('15c. Exactly 19 canonical wines present, no extra/missing', wines.length === Object.keys(CANONICAL_PRICES).length &&
  wines.every(w => CANONICAL_PRICES[w.name] !== undefined),
  'wine count ' + wines.length + ' vs canonical list ' + Object.keys(CANONICAL_PRICES).length);

// ---------------------------------------------------------------------------
// Print results
// ---------------------------------------------------------------------------
console.log('='.repeat(70));
console.log('NOMADE MENU SEED v1 — DETERMINISTIC VALIDATION');
console.log('='.repeat(70));
results.forEach(r => {
  console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.label + (r.detail ? '  [' + r.detail + ']' : ''));
});
console.log('-'.repeat(70));
console.log('Exact counts:');
console.log('  Categories:                    ' + categoryKeys.length);
console.log('  Top-level regular items:       ' + topLevelItems.length + ' (includes ' + popupParents.length + ' popup parents)');
console.log('  Popup parents:                 ' + popupParents.length);
console.log('  Popup variants:                ' + totalVariants);
console.log('  Bottled wines:                 ' + wines.length);
console.log('  Total unique order keys:       ' + allNames.length +
  ' = ' + topLevelItems.length + ' top-level + ' + totalVariants + ' variants + ' + wines.length + ' wines');
console.log('-'.repeat(70));
console.log(failures.length === 0
  ? 'RESULT: ALL CHECKS PASSED (' + results.length + '/' + results.length + ')'
  : 'RESULT: ' + failures.length + ' CHECK(S) FAILED of ' + results.length);
console.log('='.repeat(70));

process.exit(failures.length === 0 ? 0 : failures.length);
