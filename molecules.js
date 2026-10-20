// Our registered products (from the CPR / CLIDP list), matched against tender text.
// Edit molecules.json to add products; food supplements and teas are left out on purpose.
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

module.exports = { matchMolecules };
