export interface Recipe {
  title: string;
  ingredients: string[];
  instructions: string[];
  cookTime: string;
  source: string;
}

export interface SearchResponse {
  recipes: Recipe[];
  warning?: string;
  detail?: string;
  error?: string;
}
