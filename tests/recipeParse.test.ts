import { parseRecipes } from '@/lib/recipeParse';

const sources = ['https://a.com/r1', 'https://b.com/r2'];
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra ?? ''); }
};

// 1. The exact production failure: array truncated mid-object, no closing "]".
const truncated = `{"recipes": [
  {"title":"Garlic Chicken","ingredients":["chicken","garlic"],"instructions":["Sear","Bake"],"cookTime":"30 min","source":"https://a.com/r1"},
  {"title":"Lemon Chicken","ingredients":["chicken","lemon"],"instructions":["Marinate","Grill"],"cookTime":"25 min","source":"https://b.com/r2"},
  {"title":"Butter Chick`;
const r1 = parseRecipes(truncated, sources);
check('truncated response salvages complete recipes', r1.length === 2, r1);
check('salvaged titles correct', r1[0].title === 'Garlic Chicken' && r1[1].title === 'Lemon Chicken');

// 2. Old happy path: bare JSON array.
const bare = `[{"title":"Pasta","ingredients":["pasta"],"instructions":["Boil"],"cookTime":"10 min","source":"https://a.com/r1"}]`;
check('bare array still parses', parseRecipes(bare, sources).length === 1);

// 3. JSON-mode object wrapper.
const wrapped = `{"recipes":[{"title":"Soup","ingredients":["broth"],"instructions":["Simmer"],"cookTime":"1 hr","source":"https://b.com/r2"}]}`;
check('object wrapper parses', parseRecipes(wrapped, sources).length === 1);

// 4. Markdown fences + prose preamble.
const fenced = "Here you go:\n```json\n[{\"title\":\"Tacos\",\"ingredients\":[\"tortilla\"],\"instructions\":[\"Fill\"],\"cookTime\":\"15 min\",\"source\":\"https://a.com/r1\"}]\n```";
check('fenced + preamble parses', parseRecipes(fenced, sources).length === 1);

// 5. Strings instead of arrays (previously silently dropped by Array.isArray filter).
const strShape = `{"recipes":[{"title":"Curry","ingredients":"chicken; onion; curry powder","instructions":"1. Fry onion 2. Add chicken 3. Simmer","cookTime":"40 min","source":"https://a.com/r1"}]}`;
const r5 = parseRecipes(strShape, sources);
check('string ingredients coerced', r5.length === 1 && r5[0].ingredients.length === 3, r5[0]?.ingredients);
check('numbered instructions split', r5[0].instructions.length === 3, r5[0]?.instructions);

// 6. Braces inside string values must not confuse the scanner.
const braces = `[{"title":"Weird {dish}","ingredients":["a \\" quote","}"],"instructions":["step {1}"],"cookTime":"5 min","source":"https://a.com/r1"}`;
const r6 = parseRecipes(braces, sources);
check('braces/quotes inside strings handled', r6.length === 1 && r6[0].title === 'Weird {dish}', r6);

// 7. Hallucinated source URL falls back to a real one.
const badSrc = `{"recipes":[{"title":"X","ingredients":["a"],"instructions":["b"],"cookTime":"1 min","source":"https://made-up.example/nope"}]}`;
check('hallucinated source replaced', parseRecipes(badSrc, sources)[0].source === 'https://a.com/r1');

// 8. Genuinely unusable output yields nothing (so the route reports failure).
check('garbage yields no recipes', parseRecipes('I could not find any recipes, sorry.', sources).length === 0);

// 9. Incomplete recipes are dropped, not emitted half-built.
const partial = `{"recipes":[{"title":"NoSteps","ingredients":["a"],"instructions":[],"cookTime":"1 min","source":"https://a.com/r1"}]}`;
check('recipe with no instructions dropped', parseRecipes(partial, sources).length === 0);

// 10. Missing cookTime gets a placeholder rather than undefined.
const noTime = `{"recipes":[{"title":"Y","ingredients":["a"],"instructions":["b"],"source":"https://a.com/r1"}]}`;
check('missing cookTime defaults', parseRecipes(noTime, sources)[0].cookTime === 'N/A');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
