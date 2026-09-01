const PAPER_COLUMNS = [
  "doi TEXT",
  "abstract TEXT",
  "year INTEGER",
  "venue TEXT",
  "journal TEXT",
  "oa_status TEXT",
  "source_batch TEXT",
  "created_at BIGINT",
  "updated_at BIGINT",
  "arxiv_id TEXT",
  "authors_json TEXT",
  "abs_url TEXT",
  "pdf_url TEXT",
  "patent_number TEXT",
  "category TEXT",
  "material_name TEXT",
  "symmetry_phase TEXT",
  "structure_descriptor TEXT",
  "properties TEXT",
  "applications TEXT",
  "synthesis_method TEXT",
  "characterization_method TEXT",
  "quality_control TEXT",
  "first_author TEXT",
  "corresponding_author TEXT",
  "citation_count INTEGER DEFAULT 0",
  "download_count INTEGER DEFAULT 0",
  "relevance_score DOUBLE PRECISION DEFAULT 0",
  "credibility_score DOUBLE PRECISION DEFAULT 0",
  "language TEXT",
  "summary TEXT",
];

const PDF_COLUMNS = [
  "relative_path TEXT",
  "storage_kind TEXT DEFAULT 'database'",
  "file_mtime_ms BIGINT",
  "file_status TEXT DEFAULT 'active'",
  "parse_status TEXT DEFAULT 'ready'",
  "parse_error TEXT",
  "parse_attempts INTEGER DEFAULT 0",
  "last_seen_at BIGINT",
  "text_extracted_at BIGINT",
];

export async function ensureServerPdfSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS papers (
      paper_id TEXT PRIMARY KEY,
      doi TEXT,
      title TEXT NOT NULL,
      abstract TEXT,
      year INTEGER,
      venue TEXT,
      journal TEXT,
      oa_status TEXT,
      source_batch TEXT,
      created_at BIGINT,
      updated_at BIGINT,
      arxiv_id TEXT,
      authors_json TEXT,
      abs_url TEXT,
      pdf_url TEXT,
      patent_number TEXT,
      category TEXT,
      material_name TEXT,
      symmetry_phase TEXT,
      structure_descriptor TEXT,
      properties TEXT,
      applications TEXT,
      synthesis_method TEXT,
      characterization_method TEXT,
      quality_control TEXT,
      first_author TEXT,
      corresponding_author TEXT,
      citation_count INTEGER DEFAULT 0,
      download_count INTEGER DEFAULT 0,
      relevance_score DOUBLE PRECISION DEFAULT 0,
      credibility_score DOUBLE PRECISION DEFAULT 0,
      language TEXT,
      summary TEXT
    )
  `);
  for (const definition of PAPER_COLUMNS) {
    await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS ${definition}`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS paper_pdf_files (
      paper_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/pdf',
      byte_length BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      pdf_data BYTEA,
      relative_path TEXT,
      storage_kind TEXT NOT NULL DEFAULT 'database',
      file_mtime_ms BIGINT,
      file_status TEXT NOT NULL DEFAULT 'active',
      parse_status TEXT NOT NULL DEFAULT 'ready',
      parse_error TEXT,
      parse_attempts INTEGER NOT NULL DEFAULT 0,
      last_seen_at BIGINT,
      text_extracted_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await pool.query("ALTER TABLE paper_pdf_files ALTER COLUMN pdf_data DROP NOT NULL");
  for (const definition of PDF_COLUMNS) {
    await pool.query(`ALTER TABLE paper_pdf_files ADD COLUMN IF NOT EXISTS ${definition}`);
  }
  await pool.query("UPDATE paper_pdf_files SET storage_kind = 'database' WHERE storage_kind IS NULL");
  await pool.query("UPDATE paper_pdf_files SET file_status = 'active' WHERE file_status IS NULL");
  await pool.query("UPDATE paper_pdf_files SET parse_status = CASE WHEN pdf_data IS NULL THEN 'queued' ELSE 'ready' END WHERE parse_status IS NULL");
  await pool.query("UPDATE paper_pdf_files SET parse_attempts = 0 WHERE parse_attempts IS NULL");
  await pool.query("ALTER TABLE paper_pdf_files ALTER COLUMN storage_kind SET NOT NULL");
  await pool.query("ALTER TABLE paper_pdf_files ALTER COLUMN file_status SET NOT NULL");
  await pool.query("ALTER TABLE paper_pdf_files ALTER COLUMN parse_status SET NOT NULL");
  await pool.query("ALTER TABLE paper_pdf_files ALTER COLUMN parse_attempts SET NOT NULL");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS paper_pdf_files_relative_path_unique
    ON paper_pdf_files(relative_path) WHERE relative_path IS NOT NULL
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS paper_pdf_files_sha256_idx ON paper_pdf_files(sha256)");
  await pool.query("CREATE INDEX IF NOT EXISTS paper_pdf_files_parse_queue_idx ON paper_pdf_files(parse_status, updated_at)");
}

/**
 * 为数据库渠道的模糊检索字段建立 pg_trgm 索引，避免 `ILIKE '%关键词%'` 全表顺序扫描。
 * doi_records 为预置表，缺失时跳过；papers 表由 ensureServerPdfSchema 保证存在。
 */
export async function ensureSearchTrgmIndexes(pool) {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS papers_search_trgm_idx
    ON papers USING GIN (
      material_name gin_trgm_ops,
      symmetry_phase gin_trgm_ops,
      synthesis_method gin_trgm_ops,
      structure_descriptor gin_trgm_ops
    )
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.doi_records') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS doi_records_search_trgm_idx
          ON doi_records USING GIN (
            title gin_trgm_ops,
            authors gin_trgm_ops,
            journal gin_trgm_ops
          );
      END IF;
    END $$;
  `);
}
