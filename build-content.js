/**
 * Content build script
 *
 * - Reads markdown in publication/ and project/
 * - Validates required fields and asset existence
 * - Emits JSON to data/
 *
 * Flags:
 *   --force   Continue on validation errors (log warnings)
 *   --pretty  Pretty-print JSON output
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const args = new Set(process.argv.slice(2));
const options = {
  force: args.has('--force'),
  pretty: args.has('--pretty'),
};

// Configuration
const ROOT = __dirname;
const PUBLICATIONS_DIR = path.join(ROOT, 'publication');
const PROJECTS_DIR = path.join(ROOT, 'project');
const OUTPUT_DIR = path.join(ROOT, 'data');
const PUBLICATIONS_OUTPUT = path.join(OUTPUT_DIR, 'publications.json');
const PROJECTS_OUTPUT = path.join(OUTPUT_DIR, 'projects.json');

// Make sure the data directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Recursively find markdown files in a directory (deterministic order)
function findMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) {
    console.warn(`Directory ${dir} does not exist.`);
    return [];
  }

  const items = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
  const results = [];

  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);

    if (stat.isDirectory()) {
      results.push(...findMarkdownFiles(itemPath));
    } else if (item.endsWith('.md')) {
      results.push(itemPath);
    }
  }

  return results;
}

function warnOrThrow(errors, filePath) {
  if (!errors.length) return;

  const message = `Validation failed for ${filePath}:\n - ${errors.join('\n - ')}`;

  if (options.force) {
    console.warn(message);
  } else {
    throw new Error(message);
  }
}

function normalizeAssetPath(urlPath) {
  if (!urlPath) return '';
  const cleaned = urlPath.replace(/^\//, '');
  return path.join(ROOT, cleaned);
}

// Extract info from the front matter of a publication markdown file
function extractPublicationInfo(filePath) {
  const errors = [];
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const { data } = matter(fileContent);

  let pubtype = 0;
  if (data.publication_types && data.publication_types.length > 0) {
    pubtype = parseInt(data.publication_types[0], 10);
  }

  // Generate an ID based on the file path
  const rel = path.relative(PUBLICATIONS_DIR, filePath);
  const parts = rel.split(path.sep);
  let id = '';

  if (parts.length >= 3) {
    const year = parts[0];
    const name = parts[1];
    id = `${name}-${year}`;
  } else {
    const filename = path.basename(filePath, '.md');
    id = filename !== 'index' ? filename : path.basename(path.dirname(filePath));
  }

  const year =
    data.year || parseInt((data.date || '').substring(0, 4), 10) || 0;

  if (!data.title) errors.push('Missing title');
  if (!data.authors) errors.push('Missing authors');
  if (!year) errors.push('Missing or invalid year');
  if (!data.publication) errors.push('Missing venue (publication)');

  const pdfPath = data.url_pdf || '';
  const citePath = data.url_cite || '';

  if (!pdfPath) {
    errors.push('Missing url_pdf');
  } else if (!fs.existsSync(normalizeAssetPath(pdfPath))) {
    errors.push(`PDF not found at ${pdfPath}`);
  }

  if (!citePath) {
    errors.push('Missing url_cite');
  } else if (!fs.existsSync(normalizeAssetPath(citePath))) {
    errors.push(`Citation file not found at ${citePath}`);
  }

  warnOrThrow(errors, filePath);

  return {
    id,
    title: data.title || '',
    authors: data.authors || '',
    venue: data.publication || '',
    year,
    abstract: data.abstract || '',
    tags: data.tags || [],
    type: getPublicationType(pubtype),
    pubtype: pubtype || 0,
    pdfPath,
    citePath,
    featured: Boolean(data.featured),
  };
}

// Extract info from the front matter of a project markdown file
function extractProjectInfo(filePath) {
  const errors = [];
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(fileContent);

  const rel = path.relative(PROJECTS_DIR, filePath);
  const parts = rel.split(path.sep);
  let id = '';

  if (parts.length >= 2) {
    const name = parts[0];
    id = name;
  } else {
    const filename = path.basename(filePath, '.md');
    id = filename !== 'index' ? filename : path.basename(path.dirname(filePath));
  }

  if (!data.title) errors.push('Missing title');
  if (!data.description) errors.push('Missing description');

  const aboutMatch = content.match(/## About\s+([\s\S]*?)(?=\n## |$)/);
  const fundingMatch = content.match(/## Funding\s+([\s\S]*?)(?=\n## |$)/);

  warnOrThrow(errors, filePath);

  return {
    id,
    title: data.title || '',
    description: data.description || '',
    about: aboutMatch && aboutMatch[1] ? aboutMatch[1].trim() : data.description || '',
    image: data.image || '',
    funding:
      (fundingMatch && fundingMatch[1] ? fundingMatch[1].trim() : '') ||
      data.funding ||
      '',
    start_date: data.start_date || '',
    end_date: data.end_date || '',
    tags: data.tags || [],
    url_project: data.url_project || '',
    url_code: data.url_code || '',
  };
}

// Human-readable publication type
function getPublicationType(pubtype) {
  switch (pubtype) {
    case 1:
      return 'Conference paper';
    case 2:
      return 'Journal article';
    case 3:
      return 'Preprint';
    case 4:
      return 'Report';
    case 5:
      return 'Book';
    case 6:
      return 'Book section';
    case 7:
      return 'Thesis';
    case 8:
      return 'Patent';
    default:
      return 'Publication';
  }
}

function writeJson(filePath, data) {
  const json = options.pretty
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
  fs.writeFileSync(filePath, json);
}

function buildPublicationsJson() {
  console.log('Building publications.json...');
  const markdownFiles = findMarkdownFiles(PUBLICATIONS_DIR);
  console.log(`Found ${markdownFiles.length} publication files.`);

  const publications = [];
  for (const file of markdownFiles) {
    const publicationInfo = extractPublicationInfo(file);
    if (publicationInfo) {
      publications.push(publicationInfo);
    }
  }

  publications.sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return toPosix(a.id).localeCompare(toPosix(b.id));
  });

  writeJson(PUBLICATIONS_OUTPUT, publications);
  console.log(
    `Successfully wrote ${publications.length} publications to ${PUBLICATIONS_OUTPUT}`
  );

  return publications.length;
}

function buildProjectsJson() {
  console.log('Building projects.json...');
  const markdownFiles = findMarkdownFiles(PROJECTS_DIR);
  console.log(`Found ${markdownFiles.length} project files.`);

  const projects = [];
  for (const file of markdownFiles) {
    const projectInfo = extractProjectInfo(file);
    if (projectInfo) {
      projects.push(projectInfo);
    }
  }

  projects.sort((a, b) => {
    const dateA = a.start_date ? new Date(a.start_date) : new Date(0);
    const dateB = b.start_date ? new Date(b.start_date) : new Date(0);
    if (dateB - dateA !== 0) return dateB - dateA;
    return toPosix(a.id).localeCompare(toPosix(b.id));
  });

  writeJson(PROJECTS_OUTPUT, projects);
  console.log(
    `Successfully wrote ${projects.length} projects to ${PROJECTS_OUTPUT}`
  );

  return projects.length;
}

try {
  const pubCount = buildPublicationsJson();
  const projCount = buildProjectsJson();
  console.log(
    `Build complete: ${pubCount} publications and ${projCount} projects processed.`
  );
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
