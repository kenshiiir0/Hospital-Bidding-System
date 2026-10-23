// Our registered products (from the CPR / CLIDP list), matched against tender text.
// molecules.json is generated from table products (the team's PRODUCT LIST; add products with the dashboard's
// Add Molecule). The deployed system reads the table itself (frontend/src/lib/products.mjs).
const MOLECULES = require('./molecules.json');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each alias is a word or phrase; "a+b" requires every part (combination products)
const compiled = MOLECULES.map(({ name, match }) => ({
    name,
    alternatives: match.map((alias) =>
        alias.split('+').map((part) =>
            new RegExp(`\\b${escapeRegex(part.trim()).replace(/\s+/g, '[\\s-]+')}\\b`, 'i')
        )
    )
}));

// Returns the names of our products mentioned in the text, e.g. ["Paclitaxel", "Carboplatin"]
function matchMolecules(text) {
    if (!text) return [];
    return compiled
        .filter(({ alternatives }) => alternatives.some((parts) => parts.every((re) => re.test(text))))
        .map(({ name }) => name);
}

// Lines of an item list that mention our products, e.g.
// { line: "7 1000 bottle Cetirizine 5mg/5ml, 60ml SYRUP 113.98 113,980.00", products: ["Cetirizine"] }
function matchItemLines(text) {
    if (!text) return [];
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            const products = matchMolecules(line);
            return products.length ? [{ line, products }] : [];
        });
}

module.exports = { matchMolecules, matchItemLines };
