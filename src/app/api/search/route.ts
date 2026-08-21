import { NextRequest, NextResponse } from 'next/server';
import { Recipe } from '@/types/recipe';
import { parseRecipes } from '@/lib/recipeParse';

const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').replace(/^﻿/, '').trim();
// Overridable from the Vercel dashboard so a decommissioned model is a config
// change, not a redeploy. llama-3.1-8b-instant was retired and 404s.
const GROQ_MODEL = (process.env.GROQ_MODEL || '').trim() || 'openai/gpt-oss-20b';
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').replace(/^﻿/, '').trim();

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type GroqCompletion = { content: string; truncated: boolean };

async function groqGenerate(prompt: string): Promise<GroqCompletion> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        // Groq counts reserved max_tokens against the 8000 tokens-per-minute
        // limit, so this stays around twice what five recipes actually need
        // (~1000). The parser salvages whatever completes if it runs over.
        max_tokens: 3000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        // gpt-oss spends completion tokens on reasoning before it writes any
        // JSON; keeping that short leaves the budget for actual recipes and
        // roughly halves the response. Other models reject the parameter.
        ...(GROQ_MODEL.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
      }),
    });

    if (res.status === 429) {
      if (attempt < 2) { await delay(2000 * (attempt + 1)); continue; }
      throw new Error('rate_limit');
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Groq responded with ${res.status}${detail ? `: ${detail}` : ''}`);
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Groq returned an empty completion');
    }
    return { content: content.trim(), truncated: choice.finish_reason === 'length' };
  }
  throw new Error('rate_limit');
}

type SearchResult = { title: string; description: string; url: string };

async function searchTavily(query: string): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query: query + ' recipe',
      search_depth: 'basic',
      max_results: 5,
    }),
  });

  if (!res.ok) throw new Error(`Tavily Search returned ${res.status}`);

  const data = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    // A longer snippet gives the model real ingredient text to quote instead of
    // inventing it, which keeps the completion shorter and more accurate.
    description: (r.content ?? '').slice(0, 600),
    url: r.url ?? '',
  }));
}

async function extractRecipes(results: SearchResult[]): Promise<Recipe[]> {
  const resultsText = results
    .map((r, i) => `${i + 1}. Title: ${r.title}\nDescription: ${r.description}\nURL: ${r.url}`)
    .join('\n\n');

  const prompt =
    `Extract recipe information from the following search results. ` +
    `Respond with a JSON object of the form {"recipes": [...]}. ` +
    `Each item in "recipes" must have: title (string), ingredients (array of strings), ` +
    `instructions (array of strings), cookTime (string), source (the URL string, copied exactly). ` +
    `If ingredients or instructions are not in the snippet, infer reasonable ones from the recipe title. ` +
    `Keep each recipe to at most 12 ingredients and 8 instruction steps. ` +
    `Return ONLY the JSON object — no markdown, no explanation.\n\nResults:\n\n${resultsText}`;

  const { content, truncated } = await groqGenerate(prompt);

  const sources = results.map((r) => r.url).filter(Boolean);
  const recipes = parseRecipes(content, sources);

  if (recipes.length === 0) {
    throw new Error(
      truncated
        ? 'Groq response hit the token limit before any complete recipe'
        : `Could not parse recipes from Groq response: ${content.slice(0, 200)}`,
    );
  }

  return recipes;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? '').trim();

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    if (!TAVILY_API_KEY || TAVILY_API_KEY === 'your_tavily_api_key_here') {
      return NextResponse.json(
        { error: 'TAVILY_API_KEY is not configured in .env.local' },
        { status: 500 },
      );
    }

    if (!GROQ_API_KEY || GROQ_API_KEY === 'your_groq_api_key_here') {
      return NextResponse.json(
        { error: 'GROQ_API_KEY is not configured in .env.local' },
        { status: 500 },
      );
    }

    // Step 1 — search Tavily directly with the user's query (no Groq refinement needed)
    let searchResults: SearchResult[];
    try {
      searchResults = await searchTavily(query);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json({ error: `Web search failed: ${msg}` }, { status: 502 });
    }

    if (searchResults.length === 0) {
      return NextResponse.json({ recipes: [] });
    }

    // Step 2 — extract structured recipes with Groq
    let recipes: Recipe[];
    try {
      recipes = await extractRecipes(searchResults);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'rate_limit') {
        return NextResponse.json(
          { error: 'Too many requests — please wait a few seconds and try again.' },
          { status: 429 },
        );
      }
      console.error('[search] recipe extraction failed:', msg);
      try {
        recipes = await extractRecipes(searchResults.slice(0, 3));
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : '';
        if (retryMsg === 'rate_limit') {
          return NextResponse.json(
            { error: 'Too many requests — please wait a few seconds and try again.' },
            { status: 429 },
          );
        }
        console.error('[search] retry failed:', retryMsg);
        return NextResponse.json({
          recipes: [],
          warning: 'Results found but could not extract structured recipe data.',
          detail: retryMsg,
        });
      }
    }

    return NextResponse.json({ recipes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
