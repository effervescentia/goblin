/**
 * Loaded documents: reading `.yaml` files (Bun-only), following `$tmpl('…')`
 * references, and binding their top-level tables into `$` and `$lib`.
 */
import { TEMPLATE_SCAN } from './constants';
import { withNatives } from './lib';
import { collectLocations } from './locations';
import type { Provenance } from './provenance';
import { isBareSigil, isMetaKey, isValidateKey, joinPath } from './utils';

export class Documents {
  /** Raw (unevaluated) documents by file name. */
  readonly docs = new Map<string, unknown>();
  /** `$` — shared global namespace (cross-doc values). */
  readonly appRoot: Record<string, unknown> = {};
  /** `$lib` — standard library: natives bound in code, yaml helpers merged on load. */
  readonly library: Record<string, unknown> = withNatives();
  private libLoaded = false;

  constructor(
    private readonly provenance: Provenance,
    private readonly rootDir = '.',
  ) {}

  async loadFile(file: string): Promise<unknown> {
    await this.ensureLib();
    const { YAML } = await import('bun');
    const text = await Bun.file(joinPath(this.rootDir, file)).text();
    const data = YAML.parse(text);
    this.register(file, data, text);
    await this.discoverTemplates(file, text);
    return data;
  }

  /** Merge a parsed library document under the native defaults. */
  mergeLib(data: unknown): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    Object.assign(this.library, withNatives(data as Record<string, unknown>));
  }

  /** Load the stdlib document shipped with the engine. A missing file is
   * normal (tests seed documents directly): the natives stand alone. */
  private async ensureLib(): Promise<void> {
    if (this.libLoaded) return;
    this.libLoaded = true;
    try {
      const { YAML } = await import('bun');
      const text = await Bun.file(new URL('./lib/lib.yaml', import.meta.url)).text();
      this.mergeLib(YAML.parse(text));
    } catch {
      /* no lib file — natives stand alone */
    }
  }

  /**
   * Follow `$tmpl('…')` references recursively so templates resolve without
   * manual preloading. References resolve relative to the referring file's
   * directory; results are keyed both as written (matching `evalExpr`
   * lookups) and by resolved path (deduping spellings). Each file is read at
   * most once, so cycles terminate. NOTE: the scan is textual — keep
   * `$tmpl('…')` shapes out of comments.
   */
  private async discoverTemplates(file: string, text: string): Promise<void> {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    // `matchAll` scans a copy: the recursion below must not share `lastIndex`.
    for (const match of text.matchAll(TEMPLATE_SCAN)) {
      const name = match[1]!;
      const path = dir ? `${dir}/${name}` : name;
      if (!this.docs.has(name) && !this.docs.has(path)) {
        const { YAML } = await import('bun');
        const depText = await Bun.file(joinPath(this.rootDir, path)).text();
        const depData = YAML.parse(depText);
        this.register(path, depData, depText);
        this.register(name, depData);
        await this.discoverTemplates(path, depText);
      }
    }
  }

  /** Store a document under `file`, merging top-level tables into `$`. */
  register(file: string, data: unknown, text?: string): unknown {
    const { provenance } = this;
    this.docs.set(file, data);
    if (text !== undefined && data !== null && typeof data === 'object' && !provenance.locations.has(data)) {
      collectLocations(text, data, provenance.locations);
    }
    // First spelling wins, so a template registered under both its path and
    // its bare name reports one stable source.
    if (data && typeof data === 'object' && !provenance.origins.has(data)) provenance.origins.set(data, file);
    provenance.claim(data, file);
    // Merge top-level `utils`/`math`-style tables into the app namespace
    // so `$.utils.…` works for self-contained docs like main.yaml.
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        // A document that is itself one node (a `$tmpl`'d `:param` record)
        // would otherwise bind its metadata as app-root tables.
        if (isMetaKey(k) || isValidateKey(k) || isBareSigil(k)) continue;
        if (!(k in this.appRoot)) this.appRoot[k] = provenance.claim(provenance.clone(v), file);
      }
    }
    return data;
  }

  /** `$tmpl('other.yaml')` helper + any registered template loader. */
  async loadTemplate(file: string): Promise<unknown> {
    if (!this.docs.has(file)) await this.loadFile(file);
    return this.docs.get(file);
  }
}
