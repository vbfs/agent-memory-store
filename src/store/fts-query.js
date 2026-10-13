/**
 * Safe FTS5 query builder.
 *
 * Agents send natural-language queries ("What did we decide about auth?",
 * "staging-deploy config", "decisão de autenticação"). Passing those to
 * FTS5 MATCH verbatim throws syntax errors on punctuation and treats
 * AND/OR/NOT/NEAR and "col:" as operators. Here every term is extracted
 * with a Unicode-aware splitter and emitted as a quoted string, so the
 * resulting expression can never be a syntax error.
 */

const MAX_TERMS = 32;

// Short, high-frequency function words in English and Portuguese. Kept small
// on purpose: BM25's IDF already discounts common words, this only removes
// the ones that add noise to OR queries.
const STOPWORDS = new Set(
  `a an and are as at be but by do does did for from had has have how i if in
  into is it its me my of on or our so than that the their them then there
  these they this to was we were what when where which who why will with
  you your about can could should would just also not no yes
  o os as um uma uns umas de do da dos das em no na nos nas por pelo pela
  pelos pelas para pra com sem sob sobre e ou mas que se ao aos qual quais
  quem como onde quando porque por que eu tu ele ela nos vos eles elas meu
  minha seu sua nosso nossa isso isto esse essa este esta aquele aquela foi
  ser sao era sera tem ter ha nao sim mais menos muito ja ainda`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Strips diacritics for stopword comparison only (FTS5's tokenizer does its
 * own folding with remove_diacritics=2).
 */
function fold(term) {
  return term.normalize("NFD").replace(/\p{M}+/gu, "");
}

/**
 * Extracts search terms from free text.
 *
 * @param {string} text
 * @returns {string[]} lowercase terms, stopwords removed (unless that would
 *   leave nothing), deduplicated, capped at MAX_TERMS
 */
export function extractTerms(text) {
  if (typeof text !== "string") return [];
  const raw = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length > 0);

  const seen = new Set();
  const all = [];
  for (const t of raw) {
    if (seen.has(t)) continue;
    seen.add(t);
    all.push(t);
  }

  // Single letters are noise, but single digits ("phase 3", "run 7") are not.
  const content = all.filter((t) => (t.length > 1 || /\p{N}/u.test(t)) && !STOPWORDS.has(fold(t)));
  const terms = content.length > 0 ? content : all;
  return terms.slice(0, MAX_TERMS);
}

/**
 * Builds an FTS5 MATCH expression that ORs every term as a quoted string.
 *
 * @param {string} text
 * @returns {string|null} MATCH expression, or null when the query has no
 *   searchable terms (callers should then skip FTS entirely)
 */
export function buildFtsQuery(text) {
  const terms = extractTerms(text);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
