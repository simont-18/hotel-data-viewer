/**
 * Combine every saved result file next to this script into one envelope.
 *
 * Usage:
 *   npm run combine                    # merge, dropping rerun duplicates
 *   npm run combine -- --no-dedupe     # keep every row
 *   npm run combine -- --out <path>    # custom destination
 *
 * Files are read oldest-first. When two rows share the same city, hotel and
 * GPS, the row from the newest file wins; the combined array keeps the
 * original first-seen order. The output mirrors the per-search envelope:
 * `totalRows`, `sourceFiles`, `siteReportedTotal` and `results`. A date range
 * is not part of a hotel's identity, so a combined file that mixes ranges
 * shows each hotel's most recently read range; the run prints how many ranges
 * it saw, and `MapResults.html` warns when a loaded file mixes them.
 *
 * Input is envelopes only (an object with a `results` array). The older
 * bare-array format is not supported: a stale file fails with a message
 * telling you to clear `output/` and re-run the searches.
 *
 * A file named like the output file is never read as input, which is how a
 * previous run's `combined.json` is skipped. A custom `--out` placed inside
 * `output/` under a different name IS read on later runs, so keep custom
 * outputs outside this directory (e.g. `--out ../all.json`).
 *
 * An existing output file is replaced on every run and its old contents are
 * never read as input, so rerunning does not double-count anything.
 *
 * After writing the output, the run prints a per-city table of the input files
 * that match `CityName_YYYY-MM-DD_YYYY-MM-DD.json`. A file is listed as a
 * failure when it is not a full page (`totalRows !== 50`) and its `totalRows`
 * does not match what the site reported (`siteReportedTotal`); a non-numeric
 * `siteReportedTotal` (including `null`) also fails. This was formerly the
 * separate `generate-metadata.ts` script.
 *
 * The data directory is this file's own directory (`output/`), so the script
 * works no matter which directory it is launched from.
 */
import * as fs from 'fs';
import * as path from 'path';

/** One row of a saved result file. Mirrors `SavedResult` in src/results/save.ts. */
interface SavedResult {
  hotel: string;
  city: string;
  area: string;
  gps: string;
  checkIn: string;
  checkOut: string;
  stars: number | null;
  priceUsd: number | null;
  pricePerNight: number | null;
  milesEarned: number | null;
  milesEarnedPerDollar: number | null;
}

/**
 * Envelope written by one search. Mirrors `SavedResultsFile` in
 * src/results/save.ts — the two definitions are intentionally decoupled, so
 * change them together.
 */
interface SavedResultsFile {
  destination: string;
  checkIn: string;
  checkOut: string;
  totalRows: number;
  siteReportedTotal: number | null;
  results: SavedResult[];
}

/** Envelope written by this tool. */
interface CombinedResultsFile {
  totalRows: number;
  sourceFiles: number;
  siteReportedTotal: null;
  results: SavedResult[];
}

/** Directory holding this script and the result files it combines. */
const OUTPUT_DIR = __dirname;
const DEFAULT_DEST = path.join(OUTPUT_DIR, 'combined.json');

/** Per-search file names look like `CityName_YYYY-MM-DD_YYYY-MM-DD.json`. */
const FILE_PATTERN = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/;
/** Rows in a fully populated results page. */
const FULL_PAGE_ROWS = 50;

/** One row of the per-city summary table. */
interface CityRow {
  city: string;
  files: number;
  failures: string[];
}

interface Options {
  dedupe: boolean;
  dest: string;
}

const USAGE = `Combine the JSON result files in this directory into one envelope.

Usage: npm run combine [-- [options]]

Options:
  --no-dedupe     Keep every row, including duplicates from rerun searches.
  --out <path>    Destination file (default: combined.json, next to this script).
  --help          Show this message.

Input files must be result envelopes (an object with a "results" array); the
old bare-array format is no longer supported. A file named like the output
file is never read as input, and an existing output is overwritten, never
merged. Keep custom --out targets outside this directory.
`;

function fail(message: string): never {
  console.error(`combine: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dedupe: true, dest: DEFAULT_DEST };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--no-dedupe':
        options.dedupe = false;
        break;
      case '--out': {
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) {
          fail('--out requires a file path');
        }
        options.dest = path.resolve(value);
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        fail(`unknown option "${arg}"\n\n${USAGE}`);
    }
  }
  return options;
}

/** True when the parsed JSON looks like a saved results envelope. */
function isSavedResultsFile(value: unknown): value is SavedResultsFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { results?: unknown }).results)
  );
}

/** Read one result file's envelope, failing with the file name on bad input. */
function readResults(file: string): SavedResultsFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`cannot read ${file}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`invalid JSON in ${file}: ${(err as Error).message}`);
  }
  if (!isSavedResultsFile(parsed)) {
    fail(
      `${file} is not a hotel-results file (expected an object with a "results" array). ` +
      'Pre-envelope files are no longer supported — run "npm run clear-output" and ' +
      're-run the searches.',
    );
  }
  return parsed;
}

/**
 * True when a search file looks truncated: not a full page and not the row
 * count the site reported. A missing or non-numeric `siteReportedTotal`
 * (including `null`) counts as a failure.
 */
function failsRowCountCheck(envelope: SavedResultsFile): boolean {
  const { totalRows, siteReportedTotal } = envelope;
  if (typeof totalRows !== 'number' || typeof siteReportedTotal !== 'number') {
    return true;
  }
  return totalRows !== FULL_PAGE_ROWS && totalRows !== siteReportedTotal;
}

/** Render the per-city summary as an ASCII table. */
function renderTable(rows: CityRow[]): string {
  const headers = ['City', 'Files', 'Failures'];
  const body = rows.map((row) => [
    row.city,
    String(row.files),
    row.failures.length === 0 ? '-' : row.failures.join(', '),
  ]);
  const totalFiles = rows.reduce((sum, row) => sum + row.files, 0);
  const totalFailures = rows.reduce((sum, row) => sum + row.failures.length, 0);
  const footer = ['Total', String(totalFiles), String(totalFailures)];

  const allRows = [headers, ...body, footer];
  const widths = headers.map((_, i) =>
    Math.max(...allRows.map((row) => row[i].length)),
  );

  const pad = (value: string, width: number, alignRight = false): string =>
    alignRight ? value.padStart(width) : value.padEnd(width);

  const separator = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const line = (row: string[], rightAlign = false): string =>
    `| ${row.map((cell, i) => pad(cell, widths[i], rightAlign && i > 0)).join(' | ')} |`;

  const parts = [separator, line(headers), separator];
  for (const row of body) parts.push(line(row, true));
  parts.push(separator, line(footer, true), separator);

  return parts.join('\n');
}

/** Print the per-city table, or a note when no file matched the naming pattern. */
function logCitySummary(rows: CityRow[]): void {
  console.log('');
  if (rows.length === 0) {
    console.log('No files matching CityName_YYYY-MM-DD_YYYY-MM-DD.json found.');
    return;
  }
  console.log(renderTable(rows));
}

/** Identity of a hotel row, tolerant of casing and whitespace differences. */
function hotelKey(row: SavedResult): string {
  return [row.city, row.hotel, row.gps]
    .map((value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase())
    .join('\u0000');
}

/** Compare file names the way the file system does (macOS/Windows ignore case). */
function sameName(a: string, b: string): boolean {
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `file` is the output file: this run's `--out` or `combined.json`. */
function isOutputFile(file: string, destName: string, defaultName: string): boolean {
  const name = path.basename(file);
  return sameName(name, destName) || sameName(name, defaultName);
}

/** Report how many date ranges fed the run, and what that means for duplicate rows. */
function logRangeSummary(ranges: Map<string, number>): void {
  if (ranges.size === 0) {
    return;
  }
  const labels = [...ranges.keys()].map((key) =>
    key === '|' ? 'unknown' : key.replace('|', ' → '),
  );
  const shown = labels.slice(0, 5).join(', ');
  const more = labels.length > 5 ? `, +${labels.length - 5} more` : '';
  console.log(`Date ranges: ${ranges.size} (${shown}${more})`);
  if (ranges.size > 1) {
    console.log(
      'note: duplicate hotels keep the range from the most recently read file; ' +
      'compare one date range per run for a like-for-like view.',
    );
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const dest = path.resolve(options.dest);
  const destName = path.basename(dest);
  const defaultName = path.basename(DEFAULT_DEST);
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => path.join(OUTPUT_DIR, name))
    // Never merge an output file into itself, whatever it is called.
    .filter((file) => !isOutputFile(file, destName, defaultName))
    .sort((a, b) => {
      const byTime = fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
      return byTime !== 0 ? byTime : a.localeCompare(b);
    });

  if (files.length === 0) {
    fail(`no .json files found in ${OUTPUT_DIR}`);
  }

  const unique = new Map<string, SavedResult>();
  const all: SavedResult[] = [];
  const ranges = new Map<string, number>();
  const cities = new Map<string, CityRow>();
  let inputRows = 0;
  let duplicates = 0;

  for (const file of files) {
    const envelope = readResults(file);
    const rows = envelope.results;
    inputRows += rows.length;

    const name = path.basename(file);
    const match = FILE_PATTERN.exec(name);
    if (match) {
      const cityRow = cities.get(match[1]) ?? { city: match[1], files: 0, failures: [] };
      cityRow.files += 1;
      if (failsRowCountCheck(envelope)) {
        cityRow.failures.push(name);
      }
      cities.set(match[1], cityRow);
    }

    for (const row of rows) {
      const rangeKey = `${row.checkIn ?? ''}|${row.checkOut ?? ''}`;
      ranges.set(rangeKey, (ranges.get(rangeKey) ?? 0) + 1);
      if (!options.dedupe) {
        all.push(row);
        continue;
      }
      const key = hotelKey(row);
      if (unique.has(key)) {
        duplicates += 1;
      }
      unique.set(key, row);
    }
  }

  const combined = options.dedupe ? [...unique.values()] : all;
  const out: CombinedResultsFile = {
    totalRows: combined.length,
    sourceFiles: files.length,
    siteReportedTotal: null,
    results: combined,
  };

  const existed = fs.existsSync(dest);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  } catch (err) {
    fail(`cannot write ${dest}: ${(err as Error).message}`);
  }

  const skipped = options.dedupe ? `, ${duplicates} duplicate(s) dropped` : '';
  console.log(
    `Combined ${files.length} file(s) and ${inputRows} row(s) into ` +
    `${combined.length} row(s)${skipped}.`,
  );
  logRangeSummary(ranges);
  console.log(
    `${existed ? 'Overwrote' : 'Created'} ${path.relative(process.cwd(), dest) || dest}`,
  );

  logCitySummary(
    [...cities.values()].sort((a, b) => a.city.localeCompare(b.city)),
  );
}

main();
