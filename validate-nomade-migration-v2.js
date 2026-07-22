#!/usr/bin/env node
/**
 * Deterministic validator for nomade-menu-migration-v2.json, run alongside
 * validate-nomade-seed.js (which still validates the untouched v1 seed file).
 *
 * Run: node validate-nomade-migration-v2.js
 * Exits 0 if every check passes, non-zero (count of failures) otherwise.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const V1_PATH = path.join(__dirname, 'nomade-menu-seed-v1.json');
const V2_PATH = path.join(__dirname, 'nomade-menu-migration-v2.json');
const V1_VALIDATOR = path.join(__dirname, 'validate-nomade-seed.js');

const EXPECTED_NEW_CATEGORIES = 7;
const EXPECTED_NEW_TOP_LEVEL_ITEMS = 35;
const EXPECTED_NEW_VARIANTS = 16;
const EXPECTED_NEW_WINES = 2;
const EXPECTED_NEW_UNIQUE_KEYS = 53; // 35 + 16 + 2
const EXPECTED_V1_TOTAL_KEYS = 82;
const EXPECTED_V2_TOTAL_KEYS = 135; // 82 + 53
const EXPECTED_TOTAL_CATEGORIES = 23; // 16 + 7
const EXPECTED_TOTAL_WINES = 21; // 19 + 2

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
// 1. Re-run the v1 validator first — v2 must never assume v1 is fine unchecked.
// ---------------------------------------------------------------------------
let v1ValidatorPassed = false;
try {
  execFileSync('node', [V1_VALIDATOR], { stdio: 'pipe' });
  v1ValidatorPassed = true;
} catch (e) {
  v1ValidatorPassed = false;
}
check('0. v1 validator (validate-nomade-seed.js) passes — v1 data is not removed/altered',
  v1ValidatorPassed, v1ValidatorPassed ? '' : 'see node validate-nomade-seed.js output');

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
let v1, v2;
try {
  v1 = JSON.parse(fs.readFileSync(V1_PATH, 'utf8'));
  v2 = JSON.parse(fs.readFileSync(V2_PATH, 'utf8'));
} catch (e) {
  console.error('FATAL: could not read/parse seed or migration file: ' + e.message);
  process.exit(1);
}

const newCatKeys = Object.keys(v2.newCategories || {});
const newTopLevelItems = []; // { catKey, itemId, item }
Object.entries(v2.newCategories || {}).forEach(([catKey, cat]) => {
  Object.entries(cat.items || {}).forEach(([itemId, item]) => newTopLevelItems.push({ catKey, itemId, item }));
});
const newItemsForExisting = []; // { catKey, itemId, item }
Object.entries(v2.newItemsForExistingCategories || {}).forEach(([catKey, items]) => {
  Object.entries(items).forEach(([itemId, item]) => newItemsForExisting.push({ catKey, itemId, item }));
});
const allNewTopLevel = newTopLevelItems.concat(newItemsForExisting);
const newVariants = []; // { parentKey, variant }
allNewTopLevel.forEach(({ item }) => {
  if (item.variants) item.variants.forEach(v => newVariants.push({ parentKey: item.name, variant: v }));
});
const newWines = v2.newWines || [];

// ---------------------------------------------------------------------------
// 1. Current v1 data is not removed (existingCategoryOrder matches v1 exactly,
//    and this validator run doesn't touch nomade-menu-seed-v1.json at all).
// ---------------------------------------------------------------------------
const v1CatKeysInOrder = Object.entries(v1.categories)
  .sort(([, a], [, b]) => a.sortOrder - b.sortOrder)
  .map(([k]) => k);
const existingOrderMatches = JSON.stringify(v2.existingCategoryOrder) === JSON.stringify(v1CatKeysInOrder);
check('1. v2.existingCategoryOrder matches the v1 seed file\'s 16 categories exactly (order + membership)',
  existingOrderMatches, existingOrderMatches ? '' : 'v1: ' + v1CatKeysInOrder.join(',') + ' vs v2: ' + (v2.existingCategoryOrder || []).join(','));

// ---------------------------------------------------------------------------
// 2. Exactly 7 new categories
// ---------------------------------------------------------------------------
check('2. New category count === 7', newCatKeys.length === EXPECTED_NEW_CATEGORIES, 'found ' + newCatKeys.length);

// ---------------------------------------------------------------------------
// 3. Exactly 35 new top-level items (across new categories + additions to existing ones)
// ---------------------------------------------------------------------------
check('3. New top-level item count === 35', allNewTopLevel.length === EXPECTED_NEW_TOP_LEVEL_ITEMS,
  'found ' + allNewTopLevel.length + ' (' + newTopLevelItems.length + ' in new categories + ' + newItemsForExisting.length + ' in existing categories)');

// ---------------------------------------------------------------------------
// 4. Exactly 16 new popup variants
// ---------------------------------------------------------------------------
check('4. New variant count === 16', newVariants.length === EXPECTED_NEW_VARIANTS, 'found ' + newVariants.length);

// ---------------------------------------------------------------------------
// 5. Exactly 2 new bottled wines
// ---------------------------------------------------------------------------
check('5. New wine count === 2', newWines.length === EXPECTED_NEW_WINES, 'found ' + newWines.length);

// ---------------------------------------------------------------------------
// 6. Exactly 53 new unique internal keys (35 top-level names + 16 variant names + 2 wine names)
// ---------------------------------------------------------------------------
const newNames = [];
allNewTopLevel.forEach(({ item }) => newNames.push(item.name));
newVariants.forEach(({ variant }) => newNames.push(variant.name));
newWines.forEach(w => newNames.push(w.name));
const uniqueNewNames = new Set(newNames);
check('6. New unique key count === 53 (35 + 16 + 2)', newNames.length === EXPECTED_NEW_UNIQUE_KEYS && uniqueNewNames.size === EXPECTED_NEW_UNIQUE_KEYS,
  'raw ' + newNames.length + ', unique ' + uniqueNewNames.size);

// ---------------------------------------------------------------------------
// 7. No duplicate internal IDs or internal names (within v2, and vs v1)
// ---------------------------------------------------------------------------
const dupNewNames = newNames.filter((n, i) => newNames.indexOf(n) !== i);
check('7a. No duplicate internal names within v2 additions', dupNewNames.length === 0,
  dupNewNames.length ? JSON.stringify(dupNewNames) : '');

const v1Names = [];
Object.values(v1.categories).forEach(cat => Object.values(cat.items).forEach(it => {
  v1Names.push(it.name);
  if (it.variants) it.variants.forEach(v => v1Names.push(v.name));
}));
v1.wines.forEach(w => v1Names.push(w.name));
check('7b. v1 has exactly 82 unique keys (baseline sanity check)', v1Names.length === EXPECTED_V1_TOTAL_KEYS,
  'found ' + v1Names.length);

const collisions = newNames.filter(n => v1Names.includes(n));
check('7c. No new key collides with any existing v1 key', collisions.length === 0,
  collisions.length ? JSON.stringify(collisions) : '');

const allKeysCombined = v1Names.concat(newNames);
const allUniqueCombined = new Set(allKeysCombined);
check('7d. Combined v1+v2 unique key count === 135 (82 + 53)',
  allKeysCombined.length === EXPECTED_V2_TOTAL_KEYS && allUniqueCombined.size === EXPECTED_V2_TOTAL_KEYS,
  'raw ' + allKeysCombined.length + ', unique ' + allUniqueCombined.size);

const dupCatIds = [];
const idSeen = {};
newTopLevelItems.forEach(({ catKey, itemId }) => {
  const k = catKey + '/' + itemId;
  idSeen[k] = (idSeen[k] || 0) + 1;
  if (idSeen[k] > 1) dupCatIds.push(k);
});
const newCatCollisions = newCatKeys.filter(k => v1.categories[k] || v2.existingCategoryOrder.includes(k));
check('7e. No new category key collides with an existing v1 category key', newCatCollisions.length === 0,
  newCatCollisions.length ? JSON.stringify(newCatCollisions) : '');

// ---------------------------------------------------------------------------
// 8. No duplicate records for existing breakfast drinks (Part I dedup list) —
//    verify none of these are re-created anywhere in the v2 payload.
// ---------------------------------------------------------------------------
const DEDUP_ITEM_NAMES = [
  'wineglass_sparkling',       // Glass of Sparkling
  'wine_pet_nat_white',        // Pet Nat White
  'wine_pet_nat_rose',         // Pet Nat Rose
  'wine_casters_liebart',      // Casters Liébart
  'lemonade_passion_fruit',    // Passion Fruit Lemonade
  'lemonade_red_berries',      // Red Berries Lemonade
  'mock_lavender',             // Lavender Mocktail
  'mock_secret_soda',          // Secret Soda
  'soft_why_not_pomegranate_cucumber',
  'soft_why_not_natural_cola',
  'soft_why_not_elderflower_yuzu',
  'kombucha_aquela_ginger',
  'kombucha_aquela_peppermint',
];
const reintroduced = DEDUP_ITEM_NAMES.filter(n => newNames.includes(n));
check('8. None of the "reuse, don\'t duplicate" v1 breakfast-drink keys are re-created in v2',
  reintroduced.length === 0, reintroduced.length ? JSON.stringify(reintroduced) : '');

// ---------------------------------------------------------------------------
// 9. Existing v1 prices remain unchanged — v2 must not reuse an EXISTING v1
//    itemId/name anywhere (adding a NEW item to an existing category, like
//    Homemade Tea Kombucha into nomade_kombucha, is explicitly fine and
//    expected; overwriting an existing item's own id/name is not).
// ---------------------------------------------------------------------------
const v1ItemIdsByCategory = {};
Object.entries(v1.categories).forEach(([catKey, cat]) => {
  v1ItemIdsByCategory[catKey] = new Set(Object.keys(cat.items));
});
const overwritesExistingItemId = newItemsForExisting.filter(({ catKey, itemId }) =>
  v1ItemIdsByCategory[catKey] && v1ItemIdsByCategory[catKey].has(itemId));
const reusesExistingName = allNewTopLevel.some(({ item }) => v1Names.includes(item.name)) ||
  newVariants.some(({ variant }) => v1Names.includes(variant.name));
check('9. v2 never overwrites an existing v1 itemId or reuses an existing v1 internal name (prices cannot change)',
  overwritesExistingItemId.length === 0 && !reusesExistingName,
  overwritesExistingItemId.length ? JSON.stringify(overwritesExistingItemId.map(e => e.catKey + '/' + e.itemId)) : (reusesExistingName ? 'a new item/variant reuses an existing v1 name' : ''));

// ---------------------------------------------------------------------------
// 10. Homemade Tea Kombucha (€3) is distinct from existing Homemade Kombucha (€4)
// ---------------------------------------------------------------------------
const teaKombucha = newItemsForExisting.find(e => e.item.name === 'kombucha_homemade_tea');
const existingKombucha = v1.categories.nomade_kombucha && v1.categories.nomade_kombucha.items.homemade_kombucha;
check('10a. kombucha_homemade_tea exists in v2 additions with price 3',
  !!teaKombucha && teaKombucha.item.price === 3, teaKombucha ? ('price=' + teaKombucha.item.price) : 'not found');
check('10b. Existing kombucha_homemade (v1) is untouched at price 4',
  !!existingKombucha && existingKombucha.price === 4 && existingKombucha.name === 'kombucha_homemade',
  existingKombucha ? ('price=' + existingKombucha.price) : 'not found in v1 seed');
check('10c. kombucha_homemade_tea and kombucha_homemade are distinct internal keys',
  !teaKombucha || !existingKombucha || teaKombucha.item.name !== existingKombucha.name, '');

// ---------------------------------------------------------------------------
// 11. All new categories/items/variants have RU and EN names
// ---------------------------------------------------------------------------
const missingNames = [];
Object.entries(v2.newCategories || {}).forEach(([catKey, cat]) => {
  if (!cat.nameRu || !cat.nameEn) missingNames.push('category ' + catKey);
});
allNewTopLevel.forEach(({ catKey, itemId, item }) => {
  if (!item.nameRu || !item.nameEn) missingNames.push(catKey + '/' + itemId);
});
newVariants.forEach(({ parentKey, variant }) => {
  if (!variant.ru || !variant.en) missingNames.push(parentKey + ' variant "' + variant.name + '"');
});
newWines.forEach(w => { if (!w.nameRu || !w.nameEn) missingNames.push('wine ' + w.name); });
check('11. All new categories/items/variants/wines have RU and EN names', missingNames.length === 0,
  missingNames.length ? missingNames.join('; ') : '');

// ---------------------------------------------------------------------------
// 12. All prices are numeric
// ---------------------------------------------------------------------------
const badPrices = [];
allNewTopLevel.forEach(({ catKey, itemId, item }) => {
  if (!item.isGroup && (typeof item.price !== 'number' || Number.isNaN(item.price))) badPrices.push(catKey + '/' + itemId);
});
newVariants.forEach(({ parentKey, variant }) => {
  if (typeof variant.price !== 'number' || Number.isNaN(variant.price)) badPrices.push(parentKey + '/' + variant.name);
});
newWines.forEach(w => { if (typeof w.price !== 'number' || Number.isNaN(w.price)) badPrices.push('wine ' + w.name); });
check('12. All new prices are numeric', badPrices.length === 0, badPrices.length ? badPrices.join('; ') : '');

// ---------------------------------------------------------------------------
// 13. Popup parent/variant references are valid (groupKey set, variants non-empty,
//     orderPrefix only used where declared)
// ---------------------------------------------------------------------------
const badPopups = [];
allNewTopLevel.forEach(({ catKey, itemId, item }) => {
  if (item.isGroup) {
    if (!item.groupKey) badPopups.push(catKey + '/' + itemId + ': isGroup but no groupKey');
    if (!item.variants || item.variants.length === 0) badPopups.push(catKey + '/' + itemId + ': isGroup but no variants');
    (item.variants || []).forEach(v => {
      if (!v.name || !v.ru || !v.en || typeof v.price !== 'number') badPopups.push(catKey + '/' + itemId + ': malformed variant ' + JSON.stringify(v));
    });
  }
});
check('13. Popup parent/variant structure is valid for every group item', badPopups.length === 0,
  badPopups.length ? badPopups.join('; ') : '');

// ---------------------------------------------------------------------------
// 15. No The Top stock mapping becomes active — verify zero overlap between the
//     hardcoded The Top arrays (mirrored here) and v2's new keys.
// ---------------------------------------------------------------------------
const MAIN_COURSE_ITEMS = ['Бефстроганов','Эспада','Лосось в сливках','Стейк тунца','Утиная грудка','Осьминог малиновый','Котлета по-киевски','Рибай 350г'];
const DERIVED_STOCK_NAMES = ['Рибай 350г','Бефстроганов','Стейк тунца','Салат с тунцом'];
const mainOverlap = MAIN_COURSE_ITEMS.filter(n => newNames.includes(n));
const derivedOverlap = DERIVED_STOCK_NAMES.filter(n => newNames.includes(n));
check('15. No new v2 key overlaps MAIN_COURSE_ITEMS or DERIVED_STOCK_LINKS (The Top stock rules stay inert)',
  mainOverlap.length === 0 && derivedOverlap.length === 0,
  JSON.stringify({ mainOverlap, derivedOverlap }));

// ---------------------------------------------------------------------------
// 19b. No The Top product names / old seed records in the v2 migration file
// ---------------------------------------------------------------------------
const theTopHits = [];
function scanForTheTop(value, pathLabel) {
  if (typeof value === 'string') {
    THE_TOP_MARKERS.forEach(marker => { if (value.includes(marker)) theTopHits.push(pathLabel + ' contains "' + marker + '"'); });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForTheTop(v, pathLabel + '[' + i + ']'));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => scanForTheTop(v, pathLabel + '.' + k));
  }
}
scanForTheTop(v2, 'v2');
check('No The Top product names / old seed records in nomade-menu-migration-v2.json', theTopHits.length === 0,
  theTopHits.length ? theTopHits.join('; ') : '');

// ---------------------------------------------------------------------------
// Category/bottle-wine order checks
// ---------------------------------------------------------------------------
const EXPECTED_NEW_CATEGORY_ORDER = ['brunch_eggs', 'brunch_savoury', 'brunch_sweet', 'brunch_cocktails', 'nomade_coffee', 'nomade_matcha', 'nomade_desserts'];
const actualNewOrder = newCatKeys.slice().sort((a, b) => v2.newCategories[a].sortOrder - v2.newCategories[b].sortOrder);
const newOrderMatches = JSON.stringify(actualNewOrder) === JSON.stringify(EXPECTED_NEW_CATEGORY_ORDER);
check('New category order (by sortOrder) matches the specified sequence', newOrderMatches,
  newOrderMatches ? '' : 'got: ' + actualNewOrder.join(', '));

const allNewSortOrdersLowerThanExisting = Math.max(...newCatKeys.map(k => v2.newCategories[k].sortOrder)) < 1000;
check('New categories use low sortOrder values reserved to render before existing v1 categories',
  allNewSortOrdersLowerThanExisting, '');

newWines.forEach(w => {
  check('Wine "' + w.name + '" targets menuGroup "easy_start" as specified', w.menuGroup === 'easy_start',
    'got "' + w.menuGroup + '"');
});

// ---------------------------------------------------------------------------
// Print results
// ---------------------------------------------------------------------------
console.log('='.repeat(70));
console.log('NOMADE MENU MIGRATION V2 — DETERMINISTIC VALIDATION');
console.log('='.repeat(70));
results.forEach(r => {
  console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.label + (r.detail ? '  [' + r.detail + ']' : ''));
});
console.log('-'.repeat(70));
console.log('Exact counts:');
console.log('  New categories:                 ' + newCatKeys.length);
console.log('  New top-level items:            ' + allNewTopLevel.length +
  ' (' + newTopLevelItems.length + ' in new categories, ' + newItemsForExisting.length + ' added to existing categories)');
console.log('  New variants:                   ' + newVariants.length);
console.log('  New wines:                      ' + newWines.length);
console.log('  New unique keys:                ' + uniqueNewNames.size + ' = ' +
  allNewTopLevel.length + ' items + ' + newVariants.length + ' variants + ' + newWines.length + ' wines');
console.log('  v1 baseline unique keys:        ' + v1Names.length);
console.log('  Combined v1+v2 unique keys:     ' + allUniqueCombined.size);
console.log('  Total categories after v2:      ' + (v1CatKeysInOrder.length + newCatKeys.length) + ' (expected ' + EXPECTED_TOTAL_CATEGORIES + ')');
console.log('  Total wines after v2:           ' + (v1.wines.length + newWines.length) + ' (expected ' + EXPECTED_TOTAL_WINES + ')');
console.log('-'.repeat(70));
console.log(failures.length === 0
  ? 'RESULT: ALL CHECKS PASSED (' + results.length + '/' + results.length + ')'
  : 'RESULT: ' + failures.length + ' CHECK(S) FAILED of ' + results.length);
console.log('='.repeat(70));

process.exit(failures.length === 0 ? 0 : failures.length);
