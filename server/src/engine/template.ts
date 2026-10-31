// Safe templating: {{ path.to.value | filter }}. No eval, no function calls, no prototype access.

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

export function getPath(scope: Record<string, any>, path: string): any {
  let cur: any = scope;
  for (const raw of path.split(".")) {
    const key = raw.trim();
    if (!key || FORBIDDEN.has(key)) return undefined;
    if (cur == null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

const FILTERS: Record<string, (v: any, arg?: string) => any> = {
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  trim: (v) => String(v ?? "").trim(),
  json: (v) => JSON.stringify(v ?? null),
  default: (v, arg) => (v === undefined || v === null || v === "" ? arg ?? "" : v),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  desc: (v) => v, // documentation only: describes an {{ai.x}} parameter for the agent
  length: (v) => (Array.isArray(v) || typeof v === "string" ? v.length : 0),
};

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

function evalExpr(expr: string, scope: Record<string, any>): any {
  const [path, ...filters] = expr.split("|").map((s) => s.trim());
  let value: any;
  const literal = path.match(/^["'](.*)["']$/);
  value = literal ? literal[1] : getPath(scope, path);
  for (const f of filters) {
    const m = f.match(/^(\w+)(?:\s*:\s*["']?(.*?)["']?)?$/);
    if (!m) continue;
    const fn = FILTERS[m[1]];
    if (fn) value = fn(value, m[2]);
  }
  return value;
}

/** Render a template string. If the whole string is a single expression, the raw value is returned. */
export function render(template: unknown, scope: Record<string, any>): any {
  if (typeof template !== "string") return template;
  const whole = template.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  if (whole) return evalExpr(whole[1], scope);
  return template.replace(TOKEN, (_, expr) => {
    const v = evalExpr(expr, scope);
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** Deep-render every string inside an object/array. */
export function renderDeep<T>(value: T, scope: Record<string, any>): T {
  if (typeof value === "string") return render(value, scope);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope)) as any;
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, scope);
    return out;
  }
  return value;
}
