export type TemplateVariables = Record<string, string | number>;

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** Names used as `{{name}}` in a template, without repeats. */
export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/**
 * Replaces `{{name}}` with the variable's value in a single pass, so a value that itself
 * contains `{{other}}` is never expanded again. Values are HTML-escaped for HTML parts, which
 * keeps a name like `<script>` from becoming markup in someone's inbox.
 */
export function renderTemplate(template: string, variables: TemplateVariables, kind: 'text' | 'html'): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = String(variables[name]);
    return kind === 'html' ? escapeHtml(value) : value;
  });
}
