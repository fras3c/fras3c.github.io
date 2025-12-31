#!/usr/bin/env node
/**
 * Import publications from a Scopus CSV export.
 *
 * - Creates publication/<year>/<venue-slug>/index.md and cite.bib
 * - Folder name is a short slug of the venue/conference + year folder level (year is the parent folder)
 * - PDF is expected at /publication/<year>/<venue-slug>/<venue-slug>.pdf (manual add)
 *
 * Flags:
 *   --file <path>     Scopus CSV file (required)
 *   --limit <n>       Only import the first n rows
 *   --overwrite       Overwrite existing index.md / cite.bib
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');
const PUBLICATIONS_DIR = path.join(ROOT, 'publication');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') {
      args.file = argv[i + 1];
      i++;
    } else if (arg === '--limit') {
      args.limit = parseInt(argv[i + 1], 10);
      i++;
    } else if (arg === '--overwrite') {
      args.overwrite = true;
    }
  }
  return args;
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function mapDocType(docType) {
  const normalized = (docType || '').toLowerCase();
  if (normalized.includes('conference')) return 1; // Conference proceedings
  if (normalized.includes('article')) return 2; // Journal article
  if (normalized.includes('preprint')) return 3;
  if (normalized.includes('thesis')) return 7;
  return 0;
}

function buildFrontmatter(row, venueSlug, bibPath, authorsText) {
  const pubtype = mapDocType(row['Document Type']);
  const year = parseInt(row['Year'], 10) || '';
  const abstract = row['Abstract'] || '';
  const venue = row['Source title'] || '';
  const title = row['Title'] || '';
  const pdfPath = `/publication/${year}/${venueSlug}/${venueSlug}.pdf`;
  const keywords = buildTags(row);

  return {
    title,
    authors: authorsText,
    publication_types: [String(pubtype)],
    publication: venue,
    year,
    abstract,
    tags: keywords,
    featured: false,
    url_pdf: pdfPath,
    url_cite: bibPath,
  };
}

function renderFrontmatter(frontmatter) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(', ')}]`);
    } else if (typeof value === 'string') {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function buildBibtex(row, year, venueSlug, entryType, authors, firstAuthorKey) {
  const doi = row['DOI'] || '';
  const url = row['Link'] || '';
  const title = row['Title'] || '';
  const venue = row['Source title'] || '';
  const key = buildBibKey(row, year, venueSlug, firstAuthorKey);
  const keywords = (row['Author Keywords'] || '').trim();

  const lines = [`@${entryType}{${key},`];
  if (title) lines.push(`  title = {${title}},`);
  if (authors) lines.push(`  author = {${authors}},`);
  if (year) lines.push(`  year = {${year}},`);
  if (entryType === 'article') {
    if (venue) lines.push(`  journal = {${venue}},`);
    if (row['Volume']) lines.push(`  volume = {${row['Volume']}},`);
    if (row['Issue']) lines.push(`  number = {${row['Issue']}},`);
    if (row['Page start']) lines.push(`  pages = {${row['Page start']}-${row['Page end'] || ''}},`);
  } else {
    if (venue) lines.push(`  booktitle = {${venue}},`);
  }
  if (doi) lines.push(`  doi = {${doi}},`);
  if (url) lines.push(`  url = {${url}},`);
  if (keywords) lines.push(`  keywords = {${keywords}},`);
  lines.push('}');
  return lines.join('\n');
}

function buildBibKey(row, year, venueSlug, firstAuthorKey) {
  const authorKey = (firstAuthorKey || venueSlug).replace(/[^a-zA-Z]/g, '').toUpperCase();
  const pageToken =
    (row['Page start'] || row['Art. No.'] || row['Page count'] || '1')
      .toString()
      .replace(/\D/g, '') || '1';

  return `${authorKey}${year}${pageToken}`;
}

function buildTags(row) {
  const primary = (row['Author Keywords'] || '').trim();
  const fallback = (row['Index Keywords'] || '').trim();
  const source = primary || fallback;
  return source
    .split(';')
    .map((k) => k.trim())
    .filter(Boolean);
}

function formatAuthors(row) {
  const raw = row['Author full names'] || row['Authors'] || '';
  const names = raw
    .split(';')
    .map((a) => a.replace(/\(.*?\)/g, '').replace(/\s+\d+$/, '').trim())
    .filter(Boolean)
    .map((name) => {
      if (name.includes(',')) {
        // Already in "Last, First" order
        const parts = name.split(',').map((p) => p.trim());
        return `${parts[0]}, ${parts.slice(1).join(' ')}`.trim();
      }
      const parts = name.split(/\s+/);
      if (parts.length === 1) return name;
      const last = parts.pop();
      const first = parts.join(' ');
      return `${last}, ${first}`;
    });

  const bibAuthors = names.join(' and ');
  const frontAuthors = names.join(', ');
  const firstAuthorKey = names[0] || '';

  return { bibAuthors, frontAuthors, firstAuthorKey };
}

async function importScopus({ file, limit, overwrite }) {
  if (!file) {
    throw new Error('Missing required --file <path-to-scopus.csv>');
  }
  const csvPath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const csv = fs.readFileSync(csvPath, 'utf8');
  const records = parse(csv, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  });

  console.log(`Loaded ${records.length} rows from ${csvPath}`);

  ensureDir(PUBLICATIONS_DIR);

  let processed = 0;
  const venueCounters = {};
  for (const row of records) {
    const year = parseInt(row['Year'], 10);
    const venue = row['Source title'] || '';
    const title = row['Title'] || '';

    if (!year || !venue || !title) {
      console.warn(
        `Skipping row due to missing required fields (year/title/venue): ${title || '(no title)'}`
      );
      continue;
    }

    const baseSlug = slugify(venue) || slugify(title) || 'entry';
    venueCounters[year] = venueCounters[year] || {};
    venueCounters[year][baseSlug] = (venueCounters[year][baseSlug] || 0) + 1;
    const suffix = venueCounters[year][baseSlug];
    const venueSlug = `${baseSlug}-${suffix}`;
    const dir = path.join(PUBLICATIONS_DIR, String(year), venueSlug);
    const indexPath = path.join(dir, 'index.md');
    const citePath = path.join(dir, 'cite.bib');
    const bibPath = `/publication/${year}/${venueSlug}/cite.bib`;

    if (!overwrite && fs.existsSync(indexPath)) {
      console.log(`Skipping existing entry: ${indexPath}`);
      processed += 1;
      if (limit && processed >= limit) break;
      continue;
    }

    ensureDir(dir);

    const { bibAuthors, frontAuthors, firstAuthorKey } = formatAuthors(row);
    const frontmatter = buildFrontmatter(row, venueSlug, bibPath, frontAuthors);
    fs.writeFileSync(indexPath, renderFrontmatter(frontmatter), 'utf8');

    const entryType = mapDocType(row['Document Type']) === 2 ? 'article' : 'inproceedings';
    const bibtex = buildBibtex(row, year, venueSlug, entryType, bibAuthors, firstAuthorKey);
    fs.writeFileSync(citePath, bibtex + '\n', 'utf8');

    console.log(`Imported ${title} -> ${dir}`);
    processed += 1;
    if (limit && processed >= limit) break;
  }

  console.log(`Import complete. Processed ${processed} entr${processed === 1 ? 'y' : 'ies'}.`);
}

if (require.main === module) {
  importScopus(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
