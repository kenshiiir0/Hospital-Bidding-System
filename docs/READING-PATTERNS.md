# Tender reading patterns

What the document reader (`frontend/src/lib/psDocs.mjs` for tables, `frontend/src/lib/products.mjs` for molecule, dosage and form) has met in real tenders, and how each was fixed. Every pattern below has a permanent check in `tools/check-item-lines.mjs` or `tools/check-matching.mjs`, so the safety gate blocks any change that brings it back. Both portals (PhilGEPS and PS-PhilGEPS) are read by the same code.

**Before fixing a new reading problem, look here first.** If the layout is listed, the fix belongs in that rule; don't add a second rule for the same thing.

## How to fix a reading problem

1. Look at the real lines of the document (scratch tools: `show.mjs`, `readone.mjs`, `pagetop.mjs`).
2. Name the layout in general terms. Fix the **rule**, never one tender.
3. Add the document's exact line(s) as a check, with the column header lines when the table has one (the row is read through the header in the real document).
4. Bump `RULES_VERSION` (psDocs.mjs) and `READ_RULES` (philgepsSync.mjs). Run `tools/safety-gate.sh`.
5. Snapshot every tender, re-read (Screened tenders first, then all, twice), compare every tender before and after. Every tender that got worse is checked by hand and fixed before anything is called fixed.
6. Run `tools/audit-readings.mjs` and add the pattern to this file, in the same commit as its rule and check.

## Lessons (mistakes that were made once)

- **One table can never be half filled.** Some lines with prices and others without, in one table, is a reader bug until the document proves otherwise.
- **Column labels are not reliable.** "ABC per line item" holds unit prices in PS 106895 and line totals in PhilGEPS 13300773. A lone amount column is judged by its whole table's rows (which reading gives sensible unit prices), never by its label for one tender.
- **A fix for one tender broke others three times.** "Same amount column per file" broke 106895, 13286557 and 13297582. Moving the bidder-field check before the numbers check broke 106895's infusion sets. Splitting "ABC Unit Price" in two broke 13298236. Only the before/after comparison of every tender caught them.
- **The Bid Data Sheet decides a lot first.** "The number of lot(s): One (1)" makes the tender a lot even when its items are priced one by one (user, 2026-10-30, PS 107468). Lots are hidden. Two or more lots is not a lot.
- **A row's strength must be its own.** Looking ahead into the next row borrowed strengths and made false matches (Amiodarone 200 mg tablet, Ondansetron 2 mL, Imatinib 400 mg, Ferrous + Folic Acid).

## Patterns

### Lots and packages (hidden: user, 2026-10-27 and 2026-10-30)

| Document says | Example | Rule |
|---|---|---|
| Schedule of Requirements row "1 Package Drugs and Medicines 1" | PhilGEPS 13306420 | `PACKAGE_ROW` |
| Schedule of Requirements Quantity "1 lot" / "1 package" / "lump sum" (also on its own line) | PhilGEPS 13307875, 13270736, 13274749 | `lotSchedule` |
| Price list headed "1 LOT VARIOUS DRUG AND MEDICINES 6,282,909.00" | PhilGEPS 13299815 | `LOT_TOTAL_ROW` |
| Bid Data Sheet "The number of lot(s): One (1)" (checked first), even with priced items | PS 107468 | `BDS_ONE_LOT`, `lotSchedule` |
| Table of contents entry, tender name "Lot F" / "PACKAGE 1", "number of lot(s): Two (2)" | Taguig, Adela Serra Ty | never a lot |

### Where a row starts and ends

| Document does | Example | Rule |
|---|---|---|
| Next row's number alone on a line | PS 111622, PS 114476, PhilGEPS 13305194 | `rowAhead`, `numbersBelow`, `rowText` stop at Item No. + 1 |
| Next row run onto the line | PS 94918, PhilGEPS 13300871 | `withoutNextRow` |
| Scan's loose mark after a row number ("22 . IV Infusion") | PhilGEPS 13279404 | `ROW_START` |
| Marks before the next row's name ("18 **Butamirate") | PhilGEPS 13269780 | `numbersBelow` |
| Sub-numbered rows ("8.3 PROPOFOL") | PhilGEPS 13309069 | `ROW_START` |
| Row starting with its unit ("Tablet Ferrous Salt ...", any case) | PhilGEPS 13286049, 13284382 | `UNIT_FIRST_ROW` |
| A row ends at its own numbers; the next line's numbers are another row's | PhilGEPS 13284382 | `rowText` (`ENDS_IN_NUMBERS`) |
| Quantity-first rows: the next row starts with its number and quantity ("22 30 PCS MICROSET ... 1,050.00" / "23 4 sox ...") | PhilGEPS 13308352 | `withoutNextRow`, `numbersBelow`, `ENDS_IN_NUMBERS` |
| Rows without numbers, one per line, each ending in its amounts | PS 106360 | `rowAhead` |
| Lot heading and subtotal alone on a line ("LOT 2 2,395,500.00") | PhilGEPS 13292592 | `LOT_HEADING` |
| Bidder fields under each row (brand, packaging, CPR, Amount In Words) | PhilGEPS 13300232 | `FORM_TEXT` |
| A row's numbers on a line starting with its bidder field ("CPR & COD 15,000 pcs 158.00") | PS 106895 | `numbersBelow` (form text tested after the numbers) |
| "Packaging: ..." continuing the description | PS 101007 | `FORM_TEXT` bare labels only |
| Form under the table ("Purpose:", "Requested By") | several | `FORM_TEXT` |

### Quantity, unit and Item No.

| Document does | Example | Rule |
|---|---|---|
| Rows numbered in order: first number is the Item No., never the quantity | PhilGEPS 13291631 | `itemNumberOf` |
| Item No. alone on the line above | PS 114450 | `byHeader`, `parseItemRow` |
| Quantity on the next line, or a row's numbers some lines below | PhilGEPS 13301146, PS 107172 | `rowBelow`, `numbersBelow` |
| Each cell on a line of its own | PS 106363 | `rowBelow` |
| Strength split over lines ("1" / "g Vial", "4000" / "IU/Ml") | PS 102904, PS 105627 | `STRENGTH_UNIT_START` |
| A concentration is never a quantity ("10 mg/mL") | PS 101007 | `STRENGTH_TOKEN` |
| "800 vial" in one Quantity cell; unit split around "/" or "pre-filled" | PhilGEPS 13292520, 13282441, PS 101007 | `byHeader`, `SPLIT_UNIT_END` |
| Empty cells written "-" ("1,500 - - 6,300,000.00 - -") | PhilGEPS 13282466 | `withoutEmptyCells` |
| Stock No. after the Item No. | PhilGEPS 13311929 | `parseItemColumns` |

### Column layouts

| Layout | Example | Rule |
|---|---|---|
| Item / Qty / Unit / Description / Price / Total | many | `parseItemColumns` |
| Item / Description / Unit Price / Qty / Unit | PhilGEPS 13298321, 13311929 | `priceQty` |
| Item / ABC Total / Description / Qty / Unit | PhilGEPS 13301894 | `totalFirst` |
| Item / Qty / Unit / ABC / Description (amount before the description) | PhilGEPS 13296270, 13295470, 13298283 | `qtyFirst` |
| Item / Unit / Description / Qty / Price | PhilGEPS 13303622 | `unitFirstPriced` |
| Qty / Unit on the line above, ABC/unit after the description | PhilGEPS 13298769 | `quantityAbove` |
| Molecule with its strengths as sub-rows | PhilGEPS 13265275 | `expandVariants` |
| Header over several lines, carried to the next pages | PhilGEPS 13309076 | `headersOf`, `carryHeader` |

### Amounts and which column they belong to

| Document does | Example | Rule |
|---|---|---|
| A lone ABC column ("ABC", "ABC per Item", "ABC Per Line Item") | PS 106895 (unit prices), PhilGEPS 13300773 (totals) | `abcColumn`: judged per table |
| No header, one amount per row | PS 107827 | `pageAmountMeaning`: judged per page |
| A carried header naming one amount column that the page's rows contradict | PhilGEPS 13286557 | `withPageMeaning` |
| A page's meaning never applied to a row it makes no sense for: a box of 100 tablets at ₱1,125 stays a box price; ₱11 a tablet with a garbled total stays ₱11 | PhilGEPS 13309776, PS 108640 | `withPageMeaning`, `sensibleUnitPrice` (pack units) |
| "ABC Unit Price", "ABC Total" are one column each | PhilGEPS 13298236 | `HEADER_WORDS` |
| Bidder columns left empty: "Unit Bid Price", "Unit Offer", "Total Offer", "Amount in Words", the Price Schedule form's "Unit price CIF / EXW / DDP", "Total Price delivered" | PhilGEPS 13309750, 13282462, PS 107827 | `HEADER_WORDS` bid |
| Unit Cost / Total Cost after an ABC column are the bidder's | PS 106895 | `headerColumns` (`abcSeen`) |
| An ABC/unit of ₱100,000 or more is the total | PS 102904 | `abcTotalNotUnit` |
| Third amount column; delivery text or a capital heading after the amounts | PhilGEPS 13282441, 13299243, PS 106978 | `parseItemLine`, `HEADING_TAIL` |
| Amount broken over two lines ("309,50" / "1.50") | PhilGEPS 13280005 | `joinSplitAmounts` |
| Dots between thousands ("18.300.00", "333.520.00") | PhilGEPS 13279404, PS 107166 | `withCommaThousands`, `MONEY_TOKEN` |
| Scan dropped the decimal point ("75000" for 750.00), accepted only when qty × price = total | PS 114413 | `parseItemLine` |
| Garbled amount ("3IRS.000.00") set aside, worked out from the others | PS 108640 | `GARBLED_MONEY` |

### Copies of the same row

| Document does | Example | Rule |
|---|---|---|
| Same row in several files (SoR, Tech Specs, Price Schedule, delivery plan) | many | `keepBestReading`: the complete one kept |
| Priced copy behind an unpriced copy starting alike | PhilGEPS 13300871, 13282462 | `seen` keyed on the parsed reading |
| Priced row without a strength, the strength in the Item No.'s specification ("5 Cetirizine, tablet 600,000" + "Preparation: 10mg tablet") | PS 107269 | `undosed` pairing by Item No. |

### Molecule, dosage and form (products.mjs)

| Document does | Example | Rule |
|---|---|---|
| Exact dosage; concentration × volume; our pack volume | user rules 2026-10-27 | `dosageMatches` |
| Another ingredient's dose ("+ Folic Acid", ", Niacin 1-5mg") | PS 102904 | `ownPart` |
| Combination written with "/" ("Cetirizine / Phenylephrine 5mg/10mg") | PS 107827 | `ownPart` (salt words after "/" excepted) |
| The row's own form wins over the next row's ("Capsule Folic Acid" / "Tablet Ferrous ...") | PhilGEPS 13284382 | `line` (`formText`) |
| Scan misreads: "10 rna" = 10 mg, "droDs" = drops | PhilGEPS 13279404 | `withOcrUnits`, `FORMS` |
| Misspelled names ("Rocorunium", "Epoeitin", "Suggammadex") | several | `misspelledNames` |

## Not reader problems

- **No prices in the document:** a request for quotation with blank price columns (PS 114030), or a lot price list with ceiling prices only (PhilGEPS 13299815). Shown empty and said so.
- **Poor scans:** cells lost by OCR (PS 114413, PS 107166). Recovered where the numbers add up; otherwise left empty and reported.
